const {
  connectToDatabase,
  getChaptersCollection,
  getNovelsCollection,
} = require('./db');
const { scrapeChapter, scrapeNovel } = require('./scrapers');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
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

  function normalizeChapters(chapters, novelUrl) {
    if (!Array.isArray(chapters)) {
      return [];
    }

    return chapters
      .map((chapter) => {
        if (!chapter || typeof chapter !== 'object' || typeof chapter.url !== 'string') {
          return null;
        }

        try {
          const url = new URL(chapter.url, novelUrl);
          if (!['http:', 'https:'].includes(url.protocol)) {
            return null;
          }
          return { ...chapter, url: url.toString() };
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }

  async function normalizeNovelDocument(novels, novel) {
    if (!novel) {
      return novel;
    }

    const chapters = normalizeChapters(novel.chapters, novel.url);
    const changed =
      chapters.length !== (novel.chapters || []).length ||
      chapters.some((chapter, index) => chapter.url !== novel.chapters[index]?.url);

    if (!changed) {
      return novel;
    }

    await novels.updateOne({ _id: novel._id }, { $set: { chapters, updatedAt: new Date() } });
    return { ...novel, chapters, updatedAt: new Date() };
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
  const rawPath = (req.path || '/').split('?')[0].replace(/\/+$/, '') || '/';
  const pathParts = rawPath.split('/').filter(Boolean);
  const routeIndex = pathParts.findIndex((part) =>
    ['library', 'novel', 'chapter', 'progress'].includes(part),
  );

  return routeIndex >= 0 ? `/${pathParts.slice(routeIndex).join('/')}` : rawPath;
}

async function getLibrary(res) {
  const novels = await getNovelsCollection();
  const documents = await novels.find({}).sort({ updatedAt: -1 }).toArray();
  const normalizedDocuments = await Promise.all(
    documents.map((novel) => normalizeNovelDocument(novels, novel)),
  );
  return respond(res, normalizedDocuments);
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
        synopsis: metadata.synopsis || '',
        tags: Array.isArray(metadata.tags) ? metadata.tags : [],
        chapters: normalizeChapters(metadata.chapters, url),
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

async function deleteNovel(req, res) {
  const url = getRequiredUrl(req.query?.url, 'url');
  const novels = await getNovelsCollection();
  const result = await novels.deleteOne({ url });

  if (!result.deletedCount) {
    throw new HttpError(404, 'Novel not found');
  }

  return respond(res, { deleted: true, url });
}

async function resolveChapterUrl(req, rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    throw new HttpError(400, 'url is required');
  }

  try {
    return getRequiredUrl(rawUrl, 'url');
  } catch (error) {
    const novelUrl = req.query?.novelUrl;
    if (typeof novelUrl === 'string' && novelUrl.trim()) {
      try {
        return getRequiredUrl(new URL(rawUrl, novelUrl).toString(), 'url');
      } catch {
        // Continue by checking stored novels for a matching relative chapter.
      }
    }

    const novels = await getNovelsCollection();
    const novel = await novels.findOne({ 'chapters.url': rawUrl.trim() });
    if (novel) {
      const chapter = (novel.chapters || []).find((item) => item.url === rawUrl.trim());
      if (chapter) {
        return getRequiredUrl(new URL(chapter.url, novel.url).toString(), 'url');
      }
    }

    throw error;
  }
}

async function getChapter(req, res) {
  const url = await resolveChapterUrl(req, req.query?.url);
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
  if (req.method === 'DELETE' && path === '/novel') {
    return deleteNovel(req, res);
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
