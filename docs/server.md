
---

1. `dotenv.config()`
   This loads environment variables from `.env` into `process.env` so secrets aren’t hard-coded. In my case, it keeps my **OpenAI API key** and **backend GraphQL URL** out of the codebase. It lets the project read those values at runtime (locally or in the cloud) without exposing anything sensitive.

2. `console.log("✅ Server started...")`
   This gives me an immediate signal that the server initialized. I use it locally and on Render to confirm the process booted before handling requests.

3. `const app = express()`
   This creates my Express app, which is the core object that handles routes, middleware, and responses. All server actions (API calls, file uploads, returning transcripts) flow through this `app`. Without it, there’s no routing layer or request/response lifecycle.

4. `const upload = multer({ dest: "uploads/" });`
   Multer is Express middleware for `multipart/form-data`. I point it at an `uploads/` folder so incoming audio gets written to disk temporarily. This is how I physically receive the `.webm` audio from the Chrome extension; without it, there would be no file for Whisper to transcribe.

5. `const PORT = process.env.PORT || 3000;`
   This makes the server portable. In production (Docker or Render) a platform port is injected via environment variables, while locally it falls back to 3000. I know where to send requests and where to look for logs.

6. `ffmpeg.setFfmpegPath(ffmpegPath);`
   This tells `fluent-ffmpeg` where the FFmpeg binary lives. I import `ffmpegPath` from `ffmpeg-static`, which ships a cross-platform FFmpeg so I don’t rely on system installs. This is what makes `.webm` to `.mp3` conversion and slicing reliable for the extension. Without it, conversion or slicing would fail.

7. `app.use(cors());`
   Enables Cross-Origin Resource Sharing so my Chrome extension (a different origin) can call this backend (localhost or deployed URL). Without CORS, the browser would block the requests and my frontend couldn’t talk to my backend.

8. `app.use(express.json());`
   Adds JSON body parsing so `req.body` is a real object for JSON requests. Even though `/transcribe` is a file upload, other parts of this server (like usage updates) expect JSON, and this middleware makes those reads straightforward.

---


`app.post("/transcribe", upload.single("audio"), async (req, res) => { ... })`
This line creates my main POST endpoint at `/transcribe`. `app.post` defines the HTTP POST route, which is used for sending data to the server. `upload.single("audio")` tells Multer to handle a single uploaded file with the name `"audio"`. This is the file that comes from my Chrome extension. The `async (req, res) =>` defines an asynchronous request handler so I can use `await` inside it, which is important for FFmpeg conversion, file I/O, and API calls later. This is the main function of my Whisper server — every time my app sends audio, it comes through here.

`console.log("📥 Incoming POST /transcribe")`
This is just a console log statement so I know when this server’s POST endpoint is hit. If I don’t see this message, it means something in my app is disrupting the connection.

`console.log("📎 File received:", req.file)`
This tells me what the uploaded file actually looks like. It gives me visual confirmation that the upload was successful when testing with my Chrome extension.

`console.log("🕒 Timestamps received:", req.body.startTime, req.body.endTime)`
These logs show the timestamps that were sent from the frontend. This was meant to help debug whether the timestamps coming through were correct since I wanted the frontend to be able to slice or cut the video’s audio however the user wanted.

```js
const authHeader = req.headers.authorization;
const authToken = authHeader?.startsWith("Bearer ")
  ? authHeader.slice(7)
  : null;
```

This block gets the Bearer token from the `Authorization` header. It reads the header, checks if it starts with `"Bearer"`, and then slices off that prefix to isolate the raw JWT token. This ensures that only authorized users can use my Whisper server. Otherwise, anyone could call it and rack up charges on my OpenAI API key.

```js
if (!authToken) {
  console.warn("❌ No auth token provided.");
  return res.status(401).json({ error: "Unauthorized" });
}
```

This is my Auth Guard. It’s an early exit that blocks all unauthenticated requests. If the user doesn’t have a valid token, the request immediately stops here. This is my first layer of backend security — it prevents random users or bots from accessing my Whisper endpoint and wasting API credits. It also ensures that token-based usage tracking in my GraphQL backend stays accurate.

---

Would you like to move on to the next chunk?
The next section starts with:

```js
const GRAPHQL_URL = process.env.BACKEND_GRAPHQL_URL;
const startTime = req.body.startTime || "0:00";
const endTime = req.body.endTime || "0:00";
```

That’s where the server parses timestamps, estimates token usage, and checks the user’s usage allowance before transcription — one of the most interesting and critical parts of your backend.


1. `const GRAPHQL_URL = process.env.BACKEND_GRAPHQL_URL;`
   Pulls the GraphQL backend URL from `.env` so the Whisper server knows where to send usage and auth-related requests. This connects the transcription server to your main backend where authentication, subscription status, and usage tracking live. It keeps limits and tokens in sync.

2.

```js
const startTime = req.body.startTime || "0:00";
const endTime = req.body.endTime || "0:00";
```

Reads the selected clip boundaries sent by the Chrome extension. If either is missing, it defaults to `0:00`.

3.

```js
const timeToSeconds = (t) => {
  const [min, sec] = t.split(":").map(Number);
  return min * 60 + sec;
};
```

Converts `mm:ss` to seconds. That makes it easy to calculate duration, slice the file precisely with FFmpeg, and estimate cost before calling Whisper.

4.

```js
const start = timeToSeconds(startTime);
const end = timeToSeconds(endTime);
```

Parses the two timestamps into numeric second values so you can do math on them.

5.

```js
const duration = Math.max(end - start, 1);
const estimatedTokens = Math.ceil(duration * 10);
```

`duration` is the length of the selected clip in seconds, never less than 1.
`estimatedTokens` estimates cost based on **10 tokens per second** of audio. This is a pre-check so you can block expensive requests before uploading to OpenAI.

6.

```js
console.log("🕒 Parsed duration:", duration);
console.log("🧮 Estimated tokens from timestamps:", estimatedTokens);
```

Logs duration and the token estimate so you can verify timestamp math and debug limit errors.

7.

```js
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
```

Sends a GraphQL query to **your backend** asking for the user’s current usage count. The backend identifies the user from the Bearer token.

8.

```js
const usageData = await usageResponse.json();
const currentUsage = usageData?.data?.getUsageCount ?? 0;
```

Parses the JSON response from your **backend** and extracts the usage total. Defaults to zero if the field is missing.

9.

```js
console.log("📊 Usage check:", { currentUsage, estimatedTokens });
```

Logs what the server will use to make the go or no-go decision.

10.

```js
if (currentUsage + estimatedTokens > 8000) {
  console.warn("🚫 Usage limit exceeded.");
  return res.status(403).json({
    error: "Usage limit exceeded.",
    code: "USAGE_LIMIT_REACHED",
  });
}
```

Hard-stops the request if the new total would exceed the 8,000-token cap. That prevents overuse of OpenAI credits and enforces your quota plan before any costly work runs.

if (!req.file) {
  return res.status(400).json({ error: "No audio file uploaded." });
}
This checks if the file was actually uploaded. If req.file is missing, that means the frontend didn't send an audio blob properly. So the server immediately reponds with an HTTP 400 bad request and stops running. This matter to prevent the app from trying to process a file that doesn't exist. Without this FFmpeg would crash or throw an error. It also helps catch frontend bugs quickly. 

const originalPath = path.resolve(req.file.path);
const mp3Path = path.resolve(`uploads/${req.file.filename}.mp3`);
These lines set up paths for FFmpeg to read and write audio. req.file.path is where Multer temporarily saved the uploaded .webm file. mp3Path is a new destination where you'll store the converted.mp3. path.resolve() makes the paths absolute, which prevents directory issues on different systems. This makes file handling consistent no matter where your code runs. Whether that's locally, in Docker, or on Render.

console.log("🎛️ Converting webm to mp3...");
This is when and if my app freezes or crashes, I can check the console if it got stuck before or during conversion.
```js
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
```
This is where the raw .webm file becomes a .mp3. ffmpeg(originalPath) loads the uploaded audio. .output(mp3Path) sets where the converted file will go. .AudioCodec("libmp3lame") explicitly tells FFmpeg to use the MP3 encoder. .on("end") fires when the conversion finishes succesfully. .on("error") handles conversion failures. .run() actually executes the FFmpeg command. All of this is wtapped in an await new Promise() which makes the async process awaitable so you can pause your function until conversion is done. This ensures the conversion finishes before moving on to the Whisper API. If you didn't await this, the app might try to read a file that doesn't exist yet. It's also essential for cross-platform reliability since Chrome extensions record in .webm format but Whisper only accepts .mp3, mp4, m4a, and .wav.  


```js
const slicedPath = path.resolve(`uploads/${req.file.filename}-sliced.mp3`);
```
Defines where the sliced file will go. You precompute an absolute path for a potential sliced output. Using `path.resolve` avoids relative path weirdness across Windows, Linux, Docker, or Render. If slicing happens, this is where the trimmed MP3 lands. If slicing is skipped, this path simply never gets created, which you handle later by checking which file exists.

```js
if (!isNaN(start) && !isNaN(end) && end > start) {
  console.log(`✂️ Slicing MP3 from ${start}s to ${end}s...`);
  ...
} else {
  console.warn("⚠️ Invalid timestamps; skipping slicing.");
}
```

Validate timestamps before slicing. You only slice when `start` and `end` are numeric and `end` is greater than `start`. That blocks bad inputs like empty strings, NaN values, or reversed ranges. The logs make it easy to see whether the request will be sliced or fall back to the full file.

```js
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
```

Slice the MP3 with FFmpeg and wait for it to finish. You feed FFmpeg the already-converted `mp3Path`, set the clip range with `setStartTime(start)` and `.duration(duration)`, and write the trimmed audio to `slicedPath`. Wrapping the FFmpeg call in `await new Promise(...)` forces the route handler to pause until slicing completes or fails. That guarantee is important because the next step will try to upload the file; without awaiting, you could upload a file that does not exist yet or is still being written.

Why slicing here matters to the whole system

* It enforces the user’s selected range, so Whisper only transcribes what they asked for.
* It reduces upload size and transcription cost because you send a smaller clip to OpenAI.
* The guard clause keeps the server stable. If timestamps are bad, the code logs a warning and continues with the full MP3 instead of crashing. This pairs with your later logic that picks `finalUploadPath` based on which file exists.


```js
console.log("🚀 Uploading MP3 to OpenAI...");
```

Simple progress log so you know you’ve finished conversion/slicing and are about to call the Whisper API. If a request hangs after this, you know the stall is likely in the network call or API response.


```js
const formData = new FormData();
const finalUploadPath = fs.existsSync(slicedPath) ? slicedPath : mp3Path;
formData.append("file", fs.createReadStream(finalUploadPath));
```

You prepare a multipart form.

* `finalUploadPath` picks the sliced file if it exists, otherwise it falls back to the full MP3.
* `fs.createReadStream(finalUploadPath)` streams the file from disk into the request body. This is memory efficient for larger files and avoids loading the entire audio into RAM.
  Why it matters: this preserves the user’s chosen clip range and keeps memory usage low.


```js
formData.append("model", "whisper-1");
```

Sets the target model for transcription. The API expects this field in the multipart body. Keeping the model in the form body (instead of JSON) matches the endpoint’s requirements for file uploads.


```js
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
```

You call the transcription endpoint with a multipart request.

* `Authorization` uses your server-side `OPENAI_API_KEY` from environment variables, not from the client, so your key is never exposed to the browser.
* `formData.getHeaders()` supplies the correct `Content-Type` with the multipart boundary. You should not set `Content-Type` yourself for multipart; letting `form-data` do it prevents malformed requests.
* `await fetch(...)` pauses until the network call returns, which is important to keep your control flow predictable.

Common pitfalls to be aware of here

* If `OPENAI_API_KEY` is missing in the environment, you’ll get an authentication error.
* If `finalUploadPath` does not exist, `createReadStream` will throw. Your earlier logic makes that unlikely by checking `fs.existsSync(slicedPath)` first.
* If the file is too large or the network is slow, the request can take a while. Your logs make it easier to see where time is being spent.


Perfect — this part is about **parsing and validating the Whisper API’s response** after sending the MP3. Let’s walk through what’s happening and why it’s important.

---

### 1️⃣ Receive the raw API response

```js
const raw = await response.text();
let data;
```

You get the response as plain text, not JSON yet.
You purposely use `.text()` instead of `.json()` here because Whisper sometimes returns **non-JSON errors or partial strings**, which would crash `response.json()` outright. Reading it as text gives you control — you can safely attempt to parse and handle it yourself.

---

### 2️⃣ Try parsing it as JSON

```js
try {
  data = JSON.parse(raw);
  console.log("🧠 Whisper raw response:", data);
}
```

Inside the `try` block, you manually parse the raw string into a JavaScript object (`data`).
If it succeeds, you log the entire object for debugging — this helps you confirm you got a proper transcription response from Whisper (usually a JSON like `{ text: "transcribed audio text" }`).

---

### 3️⃣ Catch malformed or failed responses

```js
catch (err) {
  console.error("❌ Failed to parse Whisper response:", raw);
  return res
    .status(500)
    .json({ error: "Could not parse Whisper response." });
}
```

If the parsing fails, that means:

* Whisper didn’t return valid JSON (could be an HTML error, server timeout message, or truncated response).
* Or something went wrong with the OpenAI endpoint (bad key, rate limit, etc.).

In that case, you immediately return an HTTP `500 Internal Server Error` with a safe JSON message so the frontend doesn’t crash trying to parse undefined data.

You also log the raw output (`raw`) so you can inspect it manually later — that’s *super useful* for debugging weird API failures.

---

### 🧩 Why this block is crucial:

* **Error resilience**: Prevents the entire backend from breaking on a malformed Whisper response.
* **Logging**: Saves context for postmortem debugging.
* **Frontend stability**: Sends a clean, consistent error format instead of a crash dump.
* **Security**: Avoids leaking raw Whisper API internals directly to the user.

---

Beautiful — this is your **file lifecycle management** section. It’s easy to overlook, but this is what keeps your server from exploding with leftover uploads. Let’s go through it line by line.

---

### 1️⃣ Create a debug directory if it doesn’t exist

```js
const debugDir = path.resolve("debug");
if (!fs.existsSync(debugDir)) {
  fs.mkdirSync(debugDir);
}
```

This ensures a `debug/` folder exists in your project root.

* `path.resolve("debug")` gives you an **absolute path** (safe across Windows, macOS, Docker).
* `fs.existsSync()` checks if the folder already exists.
* If it doesn’t, `fs.mkdirSync()` creates it.

This is the equivalent of saying: *“Make a debug backup folder if one isn’t there yet.”*
It’s a one-time safety measure that prevents crashes when you try to save files later.

---

### 2️⃣ Copy the processed MP3 to the debug folder

```js
const debugPath = path.resolve(debugDir, `${req.file.filename}.mp3`);
fs.copyFileSync(finalUploadPath, debugPath);
console.log("💾 Saved MP3 backup to:", debugPath);
```

This saves a **debug backup copy** of whatever audio file was actually uploaded to Whisper.

* If slicing happened, it backs up the sliced MP3.
* If not, it backs up the full conversion.

The reason you use `copyFileSync()` (not move) is to **preserve the working file** for deletion later while still keeping a clean backup for debugging.

That means if something goes wrong in Whisper, you can still manually inspect or re-run that file without asking the user to reupload it.

---

### 3️⃣ Clean up all temporary files

```js
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
```

Each `fs.unlink()` deletes one of the temporary files created earlier:

* `originalPath`: the raw `.webm` file uploaded by the Chrome extension.
* `mp3Path`: the full converted `.mp3`.
* `slicedPath`: the shortened version if timestamps were provided.

All three are deleted asynchronously to free disk space.
Each callback logs either success or failure — meaning you always know what files are left behind if cleanup fails.

---

### 🧩 Why this section matters:

* **Prevents server bloat**: Without this, your `uploads/` directory would fill up indefinitely.
* **Improves security**: Removes user-uploaded files after use (no sensitive audio hanging around).
* **Aids debugging**: Keeps one safe backup in `/debug` for reinspection or test reproducibility.
* **Cross-platform safe**: Works in local dev, Docker, and Render because you’re using absolute paths.

---

Beautiful — this is your **file lifecycle management** section. It’s easy to overlook, but this is what keeps your server from exploding with leftover uploads. Let’s go through it line by line.

---

### 1️⃣ Create a debug directory if it doesn’t exist

```js
const debugDir = path.resolve("debug");
if (!fs.existsSync(debugDir)) {
  fs.mkdirSync(debugDir);
}
```

This ensures a `debug/` folder exists in your project root.

* `path.resolve("debug")` gives you an **absolute path** (safe across Windows, macOS, Docker).
* `fs.existsSync()` checks if the folder already exists.
* If it doesn’t, `fs.mkdirSync()` creates it.

This is the equivalent of saying: *“Make a debug backup folder if one isn’t there yet.”*
It’s a one-time safety measure that prevents crashes when you try to save files later.

---

### 2️⃣ Copy the processed MP3 to the debug folder

```js
const debugPath = path.resolve(debugDir, `${req.file.filename}.mp3`);
fs.copyFileSync(finalUploadPath, debugPath);
console.log("💾 Saved MP3 backup to:", debugPath);
```

This saves a **debug backup copy** of whatever audio file was actually uploaded to Whisper.

* If slicing happened, it backs up the sliced MP3.
* If not, it backs up the full conversion.

The reason you use `copyFileSync()` (not move) is to **preserve the working file** for deletion later while still keeping a clean backup for debugging.

That means if something goes wrong in Whisper, you can still manually inspect or re-run that file without asking the user to reupload it.

---

### 3️⃣ Clean up all temporary files

```js
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
```

Each `fs.unlink()` deletes one of the temporary files created earlier:

* `originalPath`: the raw `.webm` file uploaded by the Chrome extension.
* `mp3Path`: the full converted `.mp3`.
* `slicedPath`: the shortened version if timestamps were provided.

All three are deleted asynchronously to free disk space.
Each callback logs either success or failure — meaning you always know what files are left behind if cleanup fails.

---

### 🧩 Why this section matters:

* **Prevents server bloat**: Without this, your `uploads/` directory would fill up indefinitely.
* **Improves security**: Removes user-uploaded files after use (no sensitive audio hanging around).
* **Aids debugging**: Keeps one safe backup in `/debug` for reinspection or test reproducibility.
* **Cross-platform safe**: Works in local dev, Docker, and Render because you’re using absolute paths.


---

### 1️⃣ Check if Whisper returned a valid result

```js
if (data && data.text) {
```

This ensures Whisper actually returned a usable transcript before proceeding.

* If `data` is undefined or doesn’t have a `.text` field, the app won’t attempt to save or update anything.
* This prevents you from falsely incrementing user usage when the transcription fails.

So this is your *"success gate"* — the block that only runs when everything above succeeded.

---

### 2️⃣ Prepare for usage tracking and logging

```js
const GRAPHQL_URL = process.env.BACKEND_GRAPHQL_URL;
const estimatedTokens = Math.ceil(data.text.split(" ").length / 0.75);
```

* The GraphQL URL is loaded from your `.env` file, so you can talk to your main backend securely.
* You then calculate a **token estimate** based on the number of words in the transcript.

  * Whisper doesn’t return exact token counts, so you approximate using `word_count / 0.75`.
  * This gives a rough but practical estimate to track against your 8,000-token limit earlier.

This connects the cost of each transcription to your user’s allowed usage.

---

### 3️⃣ Log the successful transcription and usage info

```js
console.log("✅ Transcription successful!");
console.log("📤 Sending usage increment:", {
  token: authToken,
  amount: estimatedTokens,
});
```

* These console logs confirm that Whisper worked and show how many tokens will be added to the user’s usage count.
* That’s especially useful in debugging — if the backend usage doesn’t update, you can confirm the token amount that was sent.

---

### 4️⃣ Notify the Chrome Extension (optional but elegant)

```js
if (globalThis.chrome?.runtime?.sendMessage) {
  chrome.runtime.sendMessage({
    type: "TRANSCRIPT_FETCHED",
    transcript: data.text,
    estimatedTokenCount: estimatedTokens,
  });
}
```

This directly notify your **Chrome extension background script** that the transcript is ready.

* `globalThis.chrome?.runtime?.sendMessage` checks if the server is actually running inside a Chrome-like context.
* If it is (for example, your server logic is reused or packaged for an extension background service), it sends a structured message.
* That message (`TRANSCRIPT_FETCHED`) could trigger your frontend to show the transcription instantly without polling.

It’s optional, but shows you built your backend with cross-context awareness — one codebase that can communicate with both server and extension contexts.

---

### 5️⃣ Update the user’s usage in your GraphQL backend

```js
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
```

Here’s where you close the loop:

* You send a **GraphQL mutation** to increment the user’s token usage count.
* It’s authenticated with the same JWT token you verified earlier (`authToken`), so only logged-in users can update their own usage.
* The backend mutation `incrementUsage(amount: $amount)` adds this token cost to their total usage in the database.

Why it matters:

* It enforces fair-use or subscription model.
* It keeps usage tracking consistent between the Whisper server and GraphQL backend.
* It allows to display accurate “remaining tokens” on the frontend dashboard.

---

### 🧩 Why this section is so important:

* It’s the **final link** connecting transcription results → token usage → user account.
* It’s secure (tokens verified server-side).
* It’s efficient (no extra backend requests).
* It’s extensible (you could easily modify this to support premium tiers, credits, or even billing logs).


```js
res.json({ transcript: data.text, estimatedTokens });
```

Successful response to the client. You return a clean JSON object to the caller. The frontend or extension now has the transcript and the token estimate in a predictable shape. Using `res.json(...)` sets the status to 200 and the `Content-Type` to application/json. This keeps your client code simple because it can always expect JSON on success.


```js
} else {
  console.error("❌ Whisper API returned no transcript:", data);
  res.status(500).json({ error: "Whisper API failed", details: data });
}
```

Handle Whisper success without text. If Whisper responded but `data.text` is missing, you treat it as a server failure and send HTTP 500 with a structured error. You also log the raw response for debugging. This avoids silently succeeding with empty results, which would confuse the user and break client logic.

```js
} catch (error) {
  console.error("❌ Server error:", error.message);
  res.status(500).json({ error: "Internal server error." });
}
```

Catch any unexpected server errors. Any thrown error in the whole handler is caught here. You log a concise message for visibility and return a generic 500 so you do not leak internals to the client. This keeps the API stable and secure even when conversions, file I/O, network calls, or JSON parsing fail.

```js
app.listen(PORT, () => {
  console.log(`✅ Server listening on http://localhost:${PORT}`);
});
```

Start the HTTP server and confirm the port. This starts Express on the configured port and logs the URL. It is your final health signal that the process is up and accepting requests. In Docker or Render the actual host may differ, but the log confirms the port binding worked.



