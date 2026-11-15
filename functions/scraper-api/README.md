# ⚡ Node.js Starter Function

A simple starter function. Edit `src/main.js` to get started and create something awesome! 🚀

## 🧰 Usage

### GET /ping

- Returns a "Pong" message.

**Response**

Sample `200` Response:

```text
Pong
```

### GET, POST, PUT, PATCH, DELETE /

- Returns a "Learn More" JSON response.

**Response**

Sample `200` Response:

```json
{
  "motto": "Build like a team of hundreds_",
  "learn": "https://appwrite.io/docs",
  "connect": "https://appwrite.io/discord",
  "getInspired": "https://builtwith.appwrite.io"
}
```

## ⚙️ Configuration

| Setting           | Value         |
| ----------------- | ------------- |
| Runtime           | Node (18.0)   |
| Entrypoint        | `src/main.js` |
| Build Commands    | `npm install` |
| Permissions       | `any`         |
| Timeout (Seconds) | 15            |

## 🔒 Environment Variables

The function uses Appwrite TablesDB when these variables are configured:

| Variable | Description |
| -------- | ----------- |
| `APPWRITE_DATABASE_ID` | TablesDB database ID |
| `APPWRITE_PROJECT_ID` | Appwrite project ID |
| `APPWRITE_API_KEY` | API key with read/write access to the tables |
| `APPWRITE_NOVELS_TABLE_ID` | Novels table ID (defaults to `novels`) |
| `APPWRITE_CHAPTERS_TABLE_ID` | Chapters table ID (defaults to `chapters`) |
| `APPWRITE_ENDPOINT` | Appwrite API endpoint (defaults to `https://cloud.appwrite.io/v1`) |

`MONGODB_URI` remains supported as a fallback for existing deployments. The TablesDB
tables must include the fields written by the function, including `userId`, `url`,
`title`, `author`, `synopsis`, `tags`, `chapters`, and the chapter content fields.
