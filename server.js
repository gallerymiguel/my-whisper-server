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
// =======================
// Demo mode limits
// =======================
const DEMO_REQUESTS_PER_DAY = 1;

// key: `${YYYY-MM-DD}:${ip}` -> count
const demoRequestsByIp = new Map();

function getDateKeyUTC() {
  return new Date().toISOString().slice(0, 10);
}

function getClientIp(req) {
  // app.set("trust proxy", 1) is already in your code ✅
  return (req.ip || "").replace(/^::ffff:/, "") || "unknown";
}

function parseMmSsToSeconds(t) {
  const match = /^(\d{1,2}):([0-5]?\d)$/.exec(String(t || "").trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

console.log("✅ Server started. Waiting for uploads...");
const app = express();
const upload = multer({ dest: "uploads/" });
const PORT = process.env.PORT || 3000;

ffmpeg.setFfmpegPath(ffmpegPath);

app.use(cors());
app.use(express.json());
app.set("trust proxy", 1); // trust first proxy

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// =================================================================== EXPRESS ROUTE
app.post("/transcribe", upload.single("audio"), async (req, res) => {
  try {
    console.log("📥 Incoming POST /transcribe");
    console.log("📎 File received:", req.file);
    console.log(
      "🕒 Timestamps received:",
      req.body.startTime,
      req.body.endTime
    );
// =======================
    const authHeader = req.headers.authorization;
    const authToken = authHeader?.startsWith("Bearer ")
      ? authHeader.slice(7)
      : null;

    // 🔒 AUTH GUARD (stop early if not logged in)
    const ip = getClientIp(req);
    const dateKey = getDateKeyUTC();
    const demoKey = `${dateKey}:${ip}`;

    // ✅ Demo mode: no auth token
    if (!authToken) {
      const used = demoRequestsByIp.get(demoKey) || 0;

      if (used >= DEMO_REQUESTS_PER_DAY) {
        console.warn("🚫 Demo limit reached for IP:", ip);
        return res.status(403).json({
          error: "DEMO_LIMIT",
          details:
            "Demo limit reached (1 per day). Please subscribe or try again tomorrow.",
          demo: { dailyLimit: DEMO_REQUESTS_PER_DAY, used },
        });
      }
      // Reserve usage now (counts even if they spam-click)
      record.usedSeconds += duration;
      demoUsageByIp.set(demoKey, record);

      console.log("🧪 Demo mode allowed:", {
        ip,
        dateKey,
        requestedSeconds: duration,
        usedSecondsToday: record.usedSeconds,
        remainingSeconds: DEMO_SECONDS_PER_DAY - record.usedSeconds,
      });
    }

    // const GRAPHQL_URL = process.env.BACKEND_GRAPHQL_URL;
    const startTime = req.body.startTime || "0:00";
    const endTime = req.body.endTime || "0:00";

    const start = parseMmSsToSeconds(startTime);
    const end = parseMmSsToSeconds(endTime);

    if (start === null || end === null || end <= start) {
      return res.status(400).json({
        error: "Invalid timestamps",
        details:
          "startTime/endTime must be mm:ss and endTime must be after startTime.",
      });
    }

    const duration = end - start; // real requested seconds

    const estimatedTokens = Math.ceil(duration * 10);
    console.log("🕒 Parsed duration:", duration);
    console.log("🧮 Estimated tokens from timestamps:", estimatedTokens);

    // Check usage before transcription
    if (authToken) {
      const GRAPHQL_URL = process.env.BACKEND_GRAPHQL_URL;

      const estimatedTokens = Math.ceil(duration * 10);
      console.log("🧮 Estimated tokens from timestamps:", estimatedTokens);

      const usageResponse = await fetch(GRAPHQL_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({ query: `query { getUsageCount }` }),
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
    }

    if (!req.file) {
      return res.status(400).json({ error: "No audio file uploaded." });
    }

    const originalPath = path.resolve(req.file.path);
    const mp3Path = path.resolve(`uploads/${req.file.filename}.mp3`);

    console.log("🎛️ Converting webm to mp3...");
// ============================================= FFMPEG CONVERSION 
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
    // =======================
    
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
// ==================================================== WHISPER API CALL
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
// =======================  
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
// ==================================================================== CLEAN UP
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
//===================================================================
    if (data && data.text) {
      const GRAPHQL_URL = process.env.BACKEND_GRAPHQL_URL;
      const estimatedTokens = Math.ceil(data.text.split(" ").length / 0.75);
      console.log("✅ Transcription successful!");
      console.log("📤 Sending usage increment:", {
        token: authToken,
        amount: estimatedTokens,
      });
      // ✅ Inform the Chrome Extension (if needed)
    // ================================================================== ESTIMATED TOKENS FROM TRANSCRIPTION
      if (globalThis.chrome?.runtime?.sendMessage) {
        chrome.runtime.sendMessage({
          type: "TRANSCRIPT_FETCHED",
          transcript: data.text,
          estimatedTokenCount: estimatedTokens, // ✅ pass to background.js
        });
      }
// ==========================================
      if (authToken) {
        const GRAPHQL_URL = process.env.BACKEND_GRAPHQL_URL;

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
            variables: { amount: estimatedTokens },
          }),
        });
      }

      const demoInfo = !authToken
        ? (() => {
            const r = demoUsageByIp.get(demoKey);
            return {
              dailyLimitSeconds: DEMO_SECONDS_PER_DAY,
              usedSeconds: r?.usedSeconds ?? 0,
              remainingSeconds: Math.max(
                0,
                DEMO_SECONDS_PER_DAY - (r?.usedSeconds ?? 0)
              ),
            };
          })()
        : null;

      res.json({ transcript: data.text, estimatedTokens, demo: demoInfo });
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
