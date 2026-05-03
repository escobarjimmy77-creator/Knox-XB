import axios from 'axios';
import * as cheerio from 'cheerio';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import path from 'path';
import zlib from 'zlib';
import { createServer as createViteServer } from 'vite';

const app = express();
const PORT = 3000;
const BASE_URL = 'https://www3.animeflv.net';

// ==================== PNG ICON GENERATOR ====================
function makeCRC32Table() {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c;
    }
    return t;
}
const CRC_TABLE = makeCRC32Table();
function crc32(buf: Buffer) {
    let crc = 0xffffffff;
    for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 1);
    return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type: string, data: Buffer) {
    const typeBuf = Buffer.from(type, 'ascii');
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(data.length, 0);
    const crcInput = Buffer.concat([typeBuf, data]);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(crcInput), 0);
    return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}
function generatePNG(size: number, bgR: number, bgG: number, bgB: number, accentR: number, accentG: number, accentB: number) {
    const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const ihdrData = Buffer.alloc(13);
    ihdrData.writeUInt32BE(size, 0);
    ihdrData.writeUInt32BE(size, 4);
    ihdrData[8] = 8; ihdrData[9] = 2;
    const ihdr = pngChunk('IHDR', ihdrData);
    const rawRows: Buffer[] = [];
    for (let y = 0; y < size; y++) {
        const row = Buffer.alloc(1 + size * 3);
        row[0] = 0;
        const cx = size / 2, cy = size / 2, r = size * 0.38;
        for (let x = 0; x < size; x++) {
            const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
            const inCircle = dist <= r;
            const isBar1 = !inCircle && y >= size * 0.30 && y <= size * 0.42 && x >= size * 0.22 && x <= size * 0.78;
            const isBar2 = !inCircle && y >= size * 0.47 && y <= size * 0.59 && x >= size * 0.22 && x <= size * 0.78;
            const isBar3 = !inCircle && y >= size * 0.64 && y <= size * 0.76 && x >= size * 0.22 && x <= size * 0.55;
            const useAccent = inCircle || isBar1 || isBar2 || isBar3;
            row[1 + x * 3] = useAccent ? accentR : bgR;
            row[1 + x * 3 + 1] = useAccent ? accentG : bgG;
            row[1 + x * 3 + 2] = useAccent ? accentB : bgB;
        }
        rawRows.push(row);
    }
    const raw = Buffer.concat(rawRows);
    const compressed = zlib.deflateSync(raw, { level: 6 });
    const idat = pngChunk('IDAT', compressed);
    const iend = pngChunk('IEND', Buffer.alloc(0));
    return Buffer.concat([sig, ihdr, idat, iend]);
}
const icon192 = generatePNG(192, 10, 14, 39, 124, 140, 255);
const icon512 = generatePNG(512, 10, 14, 39, 124, 140, 255);

// ==================== CACHE ====================
const cache = new Map<string, { data: any; timestamp: number }>();
const CACHE_TTL = 15 * 60 * 1000; // 15 minutes

const cacheGet = (key: string) => {
    const item = cache.get(key);
    if (!item) return null;
    if (Date.now() - item.timestamp > CACHE_TTL) {
        cache.delete(key);
        return null;
    }
    return item.data;
};

const cacheSet = (key: string, data: any) => {
    cache.set(key, { data, timestamp: Date.now() });
};

const axiosInstance = axios.create({
    baseURL: BASE_URL,
    timeout: 20000,
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    }
});

// Retry logic
const retryRequest = async (fn: () => Promise<any>, maxRetries = 3) => {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            return await fn();
        } catch (error) {
            if (attempt === maxRetries - 1) throw error;
            await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, attempt)));
        }
    }
};

app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(cors());
app.use(express.json());

app.get('/icon-192.png', (req, res) => {
    res.setHeader('Content-Type', 'image/png');
    res.end(icon192);
});
app.get('/icon-512.png', (req, res) => {
    res.setHeader('Content-Type', 'image/png');
    res.end(icon512);
});

// API Routes
app.get('/api/latest', async (req, res) => {
    try {
        const page = req.query.page || 1;
        const cacheKey = `latest_${page}`;
        const cached = cacheGet(cacheKey);
        if (cached) return res.json({ success: true, data: cached });

        const { data } = await retryRequest(() => axiosInstance.get(`/browse?order=added&page=${page}`));
        const $ = cheerio.load(data);
        const animes: any[] = [];

        $('.ListAnimes li').each((i, el) => {
            const link = $(el).find('a').attr('href') || '';
            const id = link.replace('/anime/', '');
            const imgSrc = $(el).find('img').attr('src') || '';
            const coverUrl = imgSrc.startsWith('http') ? imgSrc : `${BASE_URL}${imgSrc}`;
            
            animes.push({
                id,
                title: $(el).find('h3.Title').text().trim(),
                cover: coverUrl,
                type: $(el).find('.Type').text().trim(),
                lastEpisode: '?'
            });
        });

        cacheSet(cacheKey, animes);
        res.json({ success: true, data: animes });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/trending', async (req, res) => {
    try {
        const cacheKey = 'trending';
        const cached = cacheGet(cacheKey);
        if (cached) return res.json({ success: true, data: cached });

        const { data } = await retryRequest(() => axiosInstance.get('/'));
        const $ = cheerio.load(data);
        const animes: any[] = [];

        $('.ListAnimeTop li').each((i, el) => {
            const link = $(el).find('a').attr('href') || '';
            const id = link.replace('/anime/', '');
            const imgSrc = $(el).find('img').attr('src') || '';
            const coverUrl = imgSrc.startsWith('http') ? imgSrc : `${BASE_URL}${imgSrc}`;
            
            animes.push({
                id,
                title: $(el).find('.Title').text().trim(),
                cover: coverUrl,
                rating: $(el).find('.Votes').text().trim()
            });
        });

        cacheSet(cacheKey, animes);
        res.json({ success: true, data: animes });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/genre/:genre', async (req, res) => {
    try {
        const { genre } = req.params;
        const page = req.query.page || 1;
        const cacheKey = `genre_${genre}_${page}`;
        const cached = cacheGet(cacheKey);
        if (cached) return res.json({ success: true, data: cached });

        const { data } = await retryRequest(() => axiosInstance.get(`/browse?genre[]=${genre}&order=default&page=${page}`));
        const $ = cheerio.load(data);
        const animes: any[] = [];

        $('.ListAnimes li').each((i, el) => {
            const link = $(el).find('a').attr('href') || '';
            const id = link.replace('/anime/', '');
            const imgSrc = $(el).find('img').attr('src') || '';
            const coverUrl = imgSrc.startsWith('http') ? imgSrc : `${BASE_URL}${imgSrc}`;
            
            animes.push({
                id,
                title: $(el).find('h3.Title').text().trim(),
                cover: coverUrl,
                type: $(el).find('.Type').text().trim()
            });
        });

        cacheSet(cacheKey, animes);
        res.json({ success: true, data: animes });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/search', async (req, res) => {
    try {
        const { q } = req.query;
        if (!q) return res.status(400).json({ success: false, error: 'Query required' });

        const { data } = await retryRequest(() => axiosInstance.get(`/browse?q=${q}`));
        const $ = cheerio.load(data);
        const animes: any[] = [];

        $('.ListAnimes li').each((i, el) => {
            const link = $(el).find('a').attr('href') || '';
            const id = link.replace('/anime/', '');
            const imgSrc = $(el).find('img').attr('src') || '';
            const coverUrl = imgSrc.startsWith('http') ? imgSrc : `${BASE_URL}${imgSrc}`;
            
            animes.push({
                id,
                title: $(el).find('h3.Title').text().trim(),
                cover: coverUrl,
                type: $(el).find('.Type').text().trim()
            });
        });

        res.json({ success: true, data: animes });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/info/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const cacheKey = `info_${id}`;
        const cached = cacheGet(cacheKey);
        if (cached) return res.json({ success: true, data: cached });

        const { data } = await retryRequest(() => axiosInstance.get(`/anime/${id}`));
        const $ = cheerio.load(data);
        const episodes: any[] = [];
        const scripts = $('script');
        
        scripts.each((i, el) => {
            const contents = $(el).html() || '';
            if (contents.includes('var episodes =')) {
                const match = contents.match(/var episodes = (\[.*?\]);/);
                if (match) {
                    try {
                        const rawEps = JSON.parse(match[1]);
                        rawEps.forEach((re: any) => {
                            episodes.push({ number: re[0], id: re[1] });
                        });
                    } catch (e) {}
                }
            }
        });

        const rawCover = $('.AnimeCover img').attr('src') || '';
        const cover = rawCover.startsWith('http') ? rawCover : (rawCover.startsWith('/') ? `${BASE_URL}${rawCover}` : `${BASE_URL}/${rawCover}`);

        const info = {
            id,
            title: $('.Ficha.fcont .Title').first().text().trim() || id,
            cover,
            synopsis: $('.Description p').text().trim(),
            status: $('.AnmStts span').text().trim() || 'Finalizado',
            genres: $('.Nvgnrs a').map((i, el) => $(el).text().trim()).get(),
            episodes: episodes
        };

        cacheSet(cacheKey, info);
        res.json({ success: true, data: info });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/video/:id/:cap', async (req, res) => {
    try {
        const { id, cap } = req.params;
        const { data } = await retryRequest(() => axiosInstance.get(`/ver/${id}-${cap}`));
        const $ = cheerio.load(data);
        let servers: any[] = [];
        const scripts = $('script');
        
        scripts.each((i, el) => {
            const contents = $(el).html() || '';
            if (contents.includes('var videos =')) {
                const match = contents.match(/var videos = (\{.*?\});/);
                if (match) {
                    try {
                        const videoData = JSON.parse(match[1]);
                        if (videoData.SUB) {
                            servers = videoData.SUB.map((s: any) => ({
                                name: s.title || s.server,
                                url: s.code.includes('http') ? s.code : `https://streamwish.to/e/${s.code}`
                            }));
                        }
                    } catch (e) {}
                }
            }
        });

        res.json({ success: true, data: { servers } });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message });
    }
});

async function startServer() {
    if (process.env.NODE_ENV !== 'production') {
        const vite = await createViteServer({
            server: { middlewareMode: true },
            appType: 'spa',
        });
        app.use(vite.middlewares);
    } else {
        const distPath = path.join(process.cwd(), 'dist');
        app.use(express.static(distPath));
        app.get('*', (req, res) => {
            res.sendFile(path.join(distPath, 'index.html'));
        });
    }

    app.listen(PORT, '0.0.0.0', () => {
        console.log(`Server running at http://localhost:${PORT}`);
    });
}

startServer();
