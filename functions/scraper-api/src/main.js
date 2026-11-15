const {
  getChaptersCollection,
  getNovelsCollection,
} = require('./db');
const { scrapeChapter, scrapeNovel } = require('./scrapers');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-User-Id',
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
  if (!req.bodyRaw || !String(req.bodyRaw).trim()) {
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
    let rawUrl = value.trim().replace(/&amp;/gi, '&');
    if (rawUrl.startsWith('//')) {
      rawUrl = `https:${rawUrl}`;
    } else if (
      /^(?:www\.)?(?:novelphoenix|royalroad|chikari)\.[a-z]{2,}(?:[/:?#]|$)/i.test(
        rawUrl,
      )
    ) {
      rawUrl = `https://${rawUrl}`;
    }
    const url = new URL(rawUrl);
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error();
    }
    return url.href;
  } catch {
    throw new HttpError(400, `${fieldName} must be a valid HTTP(S) URL`);
  }
}

function getUserId(req, body = getBody(req)) {
  const queryUserId = req.query?.userId;
  const headerUserId =
    req.headers?.['x-user-id'] ||
    req.headers?.['X-User-Id'] ||
    req.headers?.['X-User-ID'];
  const userId = queryUserId || body.userId || headerUserId || 'guest';

  if (typeof userId !== 'string' || !userId.trim()) {
    throw new HttpError(400, 'userId must be a non-empty string');
  }

  return userId.trim();
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

async function normalizeNovelDocument(novels, novel, userId) {
  if (!novel) {
    return novel;
  }

  let chapters = normalizeChapters(novel.chapters, novel.url);
  let metadata = novel;
  if (chapters.length < 100 || !novel.author || !novel.synopsis) {
    try {
      const scraped = await scrapeNovel(novel.url);
      if (
        scraped.chapters.length > chapters.length ||
        !novel.author ||
        !novel.synopsis ||
        !Array.isArray(novel.tags) ||
        !novel.tags.length
      ) {
        chapters = normalizeChapters(scraped.chapters, novel.url);
        metadata = {
          ...novel,
          title: scraped.title || novel.title,
          author: scraped.author || novel.author || '',
          coverImageUrl: scraped.coverImageUrl || novel.coverImageUrl,
          cover: scraped.coverImageUrl || novel.cover,
          synopsis: scraped.synopsis || novel.synopsis || '',
          tags: scraped.tags.length ? scraped.tags : novel.tags || [],
        };
      }
    } catch {
      // Return the cached document when refreshing the source is unavailable.
    }
  }

  const changed =
    metadata.userId !== userId ||
    chapters.length !== (novel.chapters || []).length ||
    chapters.some((chapter, index) => chapter.url !== novel.chapters[index]?.url) ||
    metadata.author !== novel.author ||
    metadata.synopsis !== novel.synopsis ||
    metadata.title !== novel.title ||
    metadata.coverImageUrl !== novel.coverImageUrl ||
    metadata.cover !== novel.cover ||
    JSON.stringify(metadata.tags || []) !== JSON.stringify(novel.tags || []);

  if (!changed) {
    return novel;
  }

  const updatedAt = new Date();
  const updated = {
    ...metadata,
    userId,
    chapters,
    updatedAt,
  };
  try {
    const { _id, ...persisted } = updated;
    await novels.updateOne({ _id: novel._id }, { $set: persisted });
  } catch {
    // Keep serving the refreshed document even if the cache cannot be updated.
  }
  return updated;
}

function getPath(req) {
  const rawPath = (req.path || '/').split('?')[0].replace(/\/+$/, '') || '/';
  const pathParts = rawPath.split('/').filter(Boolean);
  const routeIndex = pathParts.findIndex((part) =>
    ['library', 'novel', 'chapter', 'progress'].includes(part),
  );

  return routeIndex >= 0 ? `/${pathParts.slice(routeIndex).join('/')}` : rawPath;
}

async function getLibrary(req, res) {
  const userId = getUserId(req);
  let novels;
  let documents;
  try {
    novels = await getNovelsCollection();
    const filter =
      userId === 'guest_local'
        ? { $or: [{ userId }, { userId: { $exists: false } }] }
        : { userId };
    documents = await novels
      .find(filter)
      .sort({ updatedAt: -1 })
      .toArray();
  } catch {
    return respond(res, { novels: [] });
  }

  const normalizedDocuments = await Promise.all(
    documents.map(async (novel) => {
      try {
        return await normalizeNovelDocument(novels, novel, userId);
      } catch {
        return novel;
      }
    }),
  );
  return respond(res, { novels: normalizedDocuments });
}

async function saveNovel(req, res) {
  const body = getBody(req);
  const userId = getUserId(req, body);
  const url = getRequiredUrl(body.url, 'url');
  const metadata = await scrapeNovel(url);
  const now = new Date();
  const novelData = {
    userId,
    url,
    title: metadata.title,
    author: metadata.author,
    coverImageUrl: metadata.coverImageUrl,
    cover: metadata.coverImageUrl,
    synopsis: metadata.synopsis || '',
    tags: Array.isArray(metadata.tags) ? metadata.tags : [],
    chapters: normalizeChapters(metadata.chapters, url),
    updatedAt: now,
  };

  try {
    const novels = await getNovelsCollection();
    const legacyNovel =
      userId === 'guest_local'
        ? await novels.findOne({ url, userId: { $exists: false } })
        : null;
    const result = await novels.findOneAndUpdate(
      legacyNovel ? { _id: legacyNovel._id } : { userId, url },
      {
        $set: novelData,
        $setOnInsert: { createdAt: now },
      },
      {
        returnDocument: 'after',
        upsert: true,
      },
    );
    return respond(res, result);
  } catch {
    return respond(res, novelData);
  }
}

async function deleteNovel(req, res) {
  const body = getBody(req);
  const userId = getUserId(req, body);
  const url = getRequiredUrl(req.query?.url || body.url, 'url');
  const novels = await getNovelsCollection();
  const result = await novels.deleteOne({ userId, url });

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
        return getRequiredUrl(
          new URL(rawUrl.trim(), getRequiredUrl(novelUrl, 'novelUrl')).toString(),
          'url',
        );
      } catch {
        // Continue by checking stored novels for a matching relative chapter.
      }
    }

    try {
      const novels = await getNovelsCollection();
      const novel = await novels.findOne({ 'chapters.url': rawUrl.trim() });
      if (novel) {
        const chapter = (novel.chapters || []).find(
          (item) => item.url === rawUrl.trim(),
        );
        if (chapter) {
          return getRequiredUrl(new URL(chapter.url, novel.url).toString(), 'url');
        }
      }
    } catch {
      // Storage is optional for resolving an absolute or relative chapter URL.
    }

    throw error;
  }
}

async function getChapter(req, res) {
  getUserId(req);
  const url = await resolveChapterUrl(req, req.query?.url);
  let chapters;
  try {
    chapters = await getChaptersCollection();
    const cachedChapter = await chapters.findOne({ url });
    if (cachedChapter) {
      return respond(res, cachedChapter);
    }
  } catch {
    chapters = null;
  }

  const chapter = await scrapeChapter(url);
  if (!chapters) {
    return respond(res, chapter);
  }

  const now = new Date();
  try {
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
        $setOnInsert: { createdAt: now },
      },
      {
        returnDocument: 'after',
        upsert: true,
      },
    );
    return respond(res, result);
  } catch {
    return respond(res, chapter);
  }
}

async function updateProgress(req, res) {
  const body = getBody(req);
  const userId = getUserId(req, body);
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
    { userId, url: novelUrl },
    {
      $set: {
        lastReadChapterUrl,
        lastReadChapterTitle: body.lastReadChapterTitle.trim(),
        ...(Number.isInteger(body.lastReadIndex) && body.lastReadIndex >= 0
          ? { lastReadIndex: body.lastReadIndex }
          : {}),
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

async function handleRequest(req, res, log, error) {
  if (req.method === 'OPTIONS') {
    return respond(res, {}, 204);
  }

  const path = getPath(req);

  if (req.method === 'GET' && path === '/library') {
    return handleRoute(getLibrary, req, res, log, error);
  }
  if (req.method === 'POST' && path === '/novel') {
    return handleRoute(saveNovel, req, res, log, error);
  }
  if (req.method === 'DELETE' && path === '/novel') {
    return handleRoute(deleteNovel, req, res, log, error);
  }
  if (req.method === 'GET' && path === '/chapter') {
    return handleRoute(getChapter, req, res, log, error);
  }
  if (req.method === 'POST' && path === '/progress') {
    return handleRoute(updateProgress, req, res, log, error);
  }

  throw new HttpError(404, 'Route not found');
}

async function handleRoute(handler, req, res, log, error) {
  try {
    return await handler(req, res);
  } catch (caughtError) {
    const status = caughtError.status || 500;
    const message = status === 500 ? 'Internal server error' : caughtError.message;

    error(caughtError.stack || caughtError.message);
    log(`${req.method} ${req.path || '/'} failed with status ${status}: ${message}`);
    return respond(res, { error: message }, status);
  }
}

module.exports = async ({ req, res, log, error }) => {
  try {
    return await handleRequest(req, res, log, error);
  } catch (caughtError) {
    const status = caughtError.status || 500;
    const message = status === 500 ? 'Internal server error' : caughtError.message;

    error(caughtError.stack || caughtError.message);
    log(`${req.method} ${req.path || '/'} failed with status ${status}: ${message}`);
    return respond(res, { error: message }, status);
  }
};
