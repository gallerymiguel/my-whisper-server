# Whisper Transcription Server

This is an Express.js backend server that handles audio transcription using OpenAI's Whisper API.

## Features

- Accepts audio uploads (WebM format)
- Converts audio to MP3 using FFmpeg
- Sends the audio to OpenAI Whisper API for transcription
- Estimates token usage and checks against a usage limit before processing
- Saves debug copies of transcribed files
- Integrates with a GraphQL API to track and increment token usage

## Setup

### Prerequisites

- Node.js
- FFmpeg (auto-configured with `ffmpeg-static`)
- OpenAI API Key
- Optional: GraphQL backend for usage tracking

### Environment Variables

Create a `.env` file in the root directory with the following keys:

```
OPENAI_API_KEY=your_openai_api_key
BACKEND_GRAPHQL_URL=https://your-graphql-endpoint.com/graphql
```

Ensure `.env` is in your `.gitignore` file.

### Installation

```
npm install
```

### Running the Server

```
node index.js
```

The server will run on `http://localhost:3000` by default.

## Endpoints

### POST `/transcribe`

Uploads and transcribes an audio file.

**Headers:**
- `Authorization: Bearer <your_token>`

**Body:**
- `audio`: Audio file (WebM)
- `duration`: Duration in seconds

**Returns:**
- `transcript`: Transcribed text
- `estimatedTokens`: Estimated token usage

## Notes

- The server checks the estimated token usage (`duration * 10`) before sending to OpenAI.
- Token usage is incremented via a GraphQL mutation if transcription is successful.

## Debugging

Transcribed MP3s are stored in the `debug/` directory.
Temporary files are auto-deleted after use.

---

© 2024 Your Name. MIT License.