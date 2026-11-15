const {
  connectToDatabase,
  getChaptersCollection,
  getNovelsCollection,
} = require('./db');
const { scrapeChapter, scrapeNovel } = require('./scrapers');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function respond(res, body, status = 200) {
  return res.json(body, status, CORS_HEADERS);
}

function getBody(req) {
  if (req.bodyJson && typeof req.bodyJson === 'object') {
    return req.bodyJson;
  }

  if (!req.bodyRaw) {
    return {};
  }

  try {
    return JSON.parse(req.bodyRaw);
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON');
  }
}

function getRequiredUrl(value, fieldName) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new HttpError(400, `${fieldName} is required`);
  }

  try {
    const url = new URL(value.trim());
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error();
    }
    return url.href;
  } catch {
    throw new HttpError(400, `${fieldName} must be a valid HTTP(S) URL`);
  }
}

function getPath(req) {
  const path = (req.path || '/').replace(/\/+$/, '');
  return path || '/';
}

async function getLibrary(res) {
  const novels = await getNovelsCollection();
  const documents = await novels.find({}).sort({ updatedAt: -1 }).toArray();
  return respond(res, documents);
}

async function saveNovel(req, res) {
  const body = getBody(req);
  const url = getRequiredUrl(body.url, 'url');
  const metadata = await scrapeNovel(url);
  const now = new Date();
  const novels = await getNovelsCollection();

  const result = await novels.findOneAndUpdate(
    { url },
    {
      $set: {
        url,
        title: metadata.title,
        author: metadata.author,
        coverImageUrl: metadata.coverImageUrl,
        chapters: metadata.chapters,
        updatedAt: now,
      },
      $setOnInsert: {
        createdAt: now,
      },
    },
    {
      returnDocument: 'after',
      upsert: true,
    },
  );

  return respond(res, result);
}

async function getChapter(req, res) {
  const url = getRequiredUrl(req.query?.url, 'url');
  const chapters = await getChaptersCollection();
  const cachedChapter = await chapters.findOne({ url });

  if (cachedChapter) {
    return respond(res, cachedChapter);
  }

  const chapter = await scrapeChapter(url);
  const now = new Date();
  const result = await chapters.findOneAndUpdate(
    { url },
    {
      $set: {
        url,
        title: chapter.title,
        content: chapter.content,
        text: chapter.text,
        updatedAt: now,
      },
      $setOnInsert: {
        createdAt: now,
      },
    },
    {
      returnDocument: 'after',
      upsert: true,
    },
  );

  return respond(res, result);
}

async function updateProgress(req, res) {
  const body = getBody(req);
  const novelUrl = getRequiredUrl(body.novelUrl || body.url, 'novelUrl');

  if (
    typeof body.lastReadChapterUrl !== 'string' ||
    !body.lastReadChapterUrl.trim() ||
    typeof body.lastReadChapterTitle !== 'string' ||
    !body.lastReadChapterTitle.trim()
  ) {
    throw new HttpError(
      400,
      'lastReadChapterUrl and lastReadChapterTitle are required',
    );
  }

  const lastReadChapterUrl = getRequiredUrl(
    body.lastReadChapterUrl,
    'lastReadChapterUrl',
  );
  const novels = await getNovelsCollection();
  const result = await novels.findOneAndUpdate(
    { url: novelUrl },
    {
      $set: {
        lastReadChapterUrl,
        lastReadChapterTitle: body.lastReadChapterTitle.trim(),
        updatedAt: new Date(),
      },
    },
    { returnDocument: 'after' },
  );

  if (!result) {
    throw new HttpError(404, 'Novel not found');
  }

  return respond(res, result);
}

async function handleRequest(req, res) {
  if (req.method === 'OPTIONS') {
    return respond(res, {}, 204);
  }

  await connectToDatabase();
  const path = getPath(req);

  if (req.method === 'GET' && path === '/library') {
    return getLibrary(res);
  }
  if (req.method === 'POST' && path === '/novel') {
    return saveNovel(req, res);
  }
  if (req.method === 'GET' && path === '/chapter') {
    return getChapter(req, res);
  }
  if (req.method === 'POST' && path === '/progress') {
    return updateProgress(req, res);
  }

  throw new HttpError(404, 'Route not found');
}

module.exports = async ({ req, res, log, error }) => {
  try {
    return await handleRequest(req, res);
  } catch (caughtError) {
    const status = caughtError.status || 500;
    const message = status === 500 ? 'Internal server error' : caughtError.message;

    error(caughtError.message);
    log(`${req.method} ${req.path || '/'} failed with status ${status}`);
    return respond(res, { error: message }, status);
  }
};
