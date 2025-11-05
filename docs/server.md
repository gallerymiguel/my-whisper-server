
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

If that reads clean to you, send the **next chunk**. The natural next section is the file handling and FFmpeg conversion:

```js
if (!req.file) { ... }
const originalPath = path.resolve(req.file.path);
const mp3Path = path.resolve(`uploads/${req.file.filename}.mp3`);
...
ffmpeg(originalPath).output(mp3Path)...
```
