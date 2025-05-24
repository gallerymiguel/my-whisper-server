import express from "express";
import cors from "cors";
import multer from "multer";
import fetch from "node-fetch";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import FormData from "form-data";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";

dotenv.config();

console.log("✅ Server started. Waiting for uploads...");
const app = express();
const upload = multer({ dest: "uploads/" });
const PORT = process.env.PORT || 3000;

ffmpeg.setFfmpegPath(ffmpegPath);

app.use(cors());
app.use(express.json());

app.post("/transcribe", upload.single("audio"), async (req, res) => {
  try {
    console.log("📥 Incoming POST /transcribe");
    console.log("📎 File received:", req.file);
    console.log(
      "🕒 Timestamps received:",
      req.body.startTime,
      req.body.endTime
    );

    const authHeader = req.headers.authorization;
    const authToken = authHeader?.startsWith("Bearer ")
      ? authHeader.slice(7)
      : null;

    // 🔒 AUTH GUARD (stop early if not logged in)
    if (!authToken) {
      console.warn("❌ No auth token provided.");
      return res.status(401).json({ error: "Unauthorized" });
    }
    const GRAPHQL_URL = process.env.BACKEND_GRAPHQL_URL;

    const startTime = req.body.startTime || "0:00";
    const endTime = req.body.endTime || "0:00";
    // Parse mm:ss into seconds
    const timeToSeconds = (t) => {
      const [min, sec] = t.split(":").map(Number);
      return min * 60 + sec;
    };

    const start = timeToSeconds(startTime);
    const end = timeToSeconds(endTime);
    const duration = Math.max(end - start, 1); // Fallback to 1 second minimum

    const estimatedTokens = Math.ceil(duration * 10);
    console.log("🕒 Parsed duration:", duration);
    console.log("🧮 Estimated tokens from timestamps:", estimatedTokens);

    // Check usage before transcription
    const usageResponse = await fetch(GRAPHQL_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        query: `query { getUsageCount }`,
      }),
    });

    const usageData = await usageResponse.json();
    const currentUsage = usageData?.data?.getUsageCount ?? 0;

    console.log("📊 Usage check:", { currentUsage, estimatedTokens });

    if (currentUsage + estimatedTokens > 8000) {
      console.warn("🚫 Usage limit exceeded.");
      return res.status(403).json({
        error: "Usage limit exceeded.",
        code: "USAGE_LIMIT_REACHED",
      });
    }

    if (!req.file) {
      return res.status(400).json({ error: "No audio file uploaded." });
    }

    const originalPath = path.resolve(req.file.path);
    const mp3Path = path.resolve(`uploads/${req.file.filename}.mp3`);

    console.log("🎛️ Converting webm to mp3...");

    await new Promise((resolve, reject) => {
      ffmpeg(originalPath)
        .output(mp3Path)
        .audioCodec("libmp3lame")
        .on("end", () => {
          console.log("✅ Conversion complete:", mp3Path);
          resolve();
        })
        .on("error", (err) => {
          console.error("❌ FFmpeg conversion error:", err);
          reject(err);
        })
        .run();
    });
    // After MP3 conversion
    const slicedPath = path.resolve(`uploads/${req.file.filename}-sliced.mp3`);

    if (!isNaN(start) && !isNaN(end) && end > start) {
      console.log(`✂️ Slicing MP3 from ${start}s to ${end}s...`);

      await new Promise((resolve, reject) => {
        ffmpeg(mp3Path)
          .setStartTime(start)
          .duration(duration)
          .output(slicedPath)
          .on("end", () => {
            console.log("✅ Slicing complete:", slicedPath);
            resolve();
          })
          .on("error", (err) => {
            console.error("❌ FFmpeg slicing error:", err);
            reject(err);
          })
          .run();
      });
    } else {
      console.warn("⚠️ Invalid timestamps; skipping slicing.");
    }

    console.log("🚀 Uploading MP3 to OpenAI...");

    const formData = new FormData();
    const finalUploadPath = fs.existsSync(slicedPath) ? slicedPath : mp3Path;
    formData.append("file", fs.createReadStream(finalUploadPath));

    formData.append("model", "whisper-1");

    const response = await fetch(
      "https://api.openai.com/v1/audio/transcriptions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          ...formData.getHeaders(),
        },
        body: formData,
      }
    );

    const raw = await response.text();
    let data;

    try {
      data = JSON.parse(raw);
      console.log("🧠 Whisper raw response:", data);
    } catch (err) {
      console.error("❌ Failed to parse Whisper response:", raw);
      return res
        .status(500)
        .json({ error: "Could not parse Whisper response." });
    }

    const debugDir = path.resolve("debug");
    if (!fs.existsSync(debugDir)) {
      fs.mkdirSync(debugDir);
    }
    const debugPath = path.resolve(debugDir, `${req.file.filename}.mp3`);
    fs.copyFileSync(finalUploadPath, debugPath);
    console.log("💾 Saved MP3 backup to:", debugPath);

    fs.unlink(originalPath, (err) => {
      if (err) console.error("❌ Failed to delete original webm:", err);
      else console.log("🗑️ Deleted temp webm:", originalPath);
    });

    fs.unlink(mp3Path, (err) => {
      if (err) console.error("❌ Failed to delete temp mp3:", err);
      else console.log("🗑️ Deleted temp mp3:", mp3Path);
    });

    fs.unlink(slicedPath, (err) => {
      if (err) console.error("❌ Failed to delete sliced mp3:", err);
      else console.log("🗑️ Deleted sliced mp3:", slicedPath);
    });

    if (data && data.text) {
      const GRAPHQL_URL = process.env.BACKEND_GRAPHQL_URL;
      const estimatedTokens = Math.ceil(data.text.split(" ").length / 0.75);
      console.log("✅ Transcription successful!");
      console.log("📤 Sending usage increment:", {
        token: authToken,
        amount: estimatedTokens,
      });
      // ✅ Inform the Chrome Extension (if needed)
      if (globalThis.chrome?.runtime?.sendMessage) {
        chrome.runtime.sendMessage({
          type: "TRANSCRIPT_FETCHED",
          transcript: data.text,
          estimatedTokenCount: estimatedTokens, // ✅ pass to background.js
        });
      }

      await fetch(GRAPHQL_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          query: `
            mutation IncrementUsage($amount: Int!) {
              incrementUsage(amount: $amount)
            }
          `,
          variables: {
            amount: estimatedTokens,
          },
        }),
      });

      res.json({ transcript: data.text, estimatedTokens });
    } else {
      console.error("❌ Whisper API returned no transcript:", data);
      res.status(500).json({ error: "Whisper API failed", details: data });
    }
  } catch (error) {
    console.error("❌ Server error:", error.message);
    res.status(500).json({ error: "Internal server error." });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server listening on http://localhost:${PORT}`);
});
