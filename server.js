// backend/server.js
const express = require('express');
const cors = require('cors');
const { spawn, exec } = require('child_process'); // Ensure 'exec' is also imported
const fs = require('fs');
const path = require('path');
const crypto = require('crypto'); // For hashing URLs
const NodeCache = require('node-cache'); // For caching search results

const app = express();
const PORT = process.env.PORT || 10000;
const AUDIO_DIR = path.join(__dirname, 'audio');

// Create audio directory if it doesn't exist
if (!fs.existsSync(AUDIO_DIR)) {
    fs.mkdirSync(AUDIO_DIR);
    console.log(`Creating audio directory: ${AUDIO_DIR}`);
} else {
    console.log(`Audio directory already exists: ${AUDIO_DIR}`);
}

// Initialize cache for search results
// Cache search results for 1 hour (3600 seconds)
const searchCache = new NodeCache({ stdTTL: 3600, checkperiod: 600 }); 

// CORS Configuration
// Define the allowed origins for your frontend applications.
// This is crucial for security and cross-origin communication.
const allowedOrigins = [
    'https://96mayar96.github.io', // Your GitHub Pages frontend URL
    'http://localhost:3000',      // For local development of your React app
    'http://127.0.0.1:3000'       // Another common local dev address
];

app.use(cors({
    origin: function (origin, callback) {
        // Allow requests with no origin (e.g., from tools like Postman, or mobile apps)
        if (!origin) return callback(null, true);
        // Check if the requesting origin is in our allowed list
        if (allowedOrigins.indexOf(origin) === -1) {
            const msg = `The CORS policy for this site does not allow access from the specified Origin: ${origin}`;
            return callback(new Error(msg), false);
        }
        return callback(null, true);
    },
    methods: ['GET', 'POST'], // Allow GET and POST requests
    allowedHeaders: ['Content-Type'], // Specify allowed request headers
    credentials: true // Allow cookies and authentication headers to be sent
}));

app.use(express.json()); // Middleware to parse JSON request bodies

// Serve static audio files from the 'audio' directory
// This makes audio files available at /audio/<filename>
app.use('/audio', express.static(AUDIO_DIR));
console.log(`Serving audio files from: ${AUDIO_DIR}`);

// Root endpoint for a basic status check
app.get('/', (req, res) => {
    res.send('Music Player Backend is running! Audio directory created if needed.');
});

/**
 * /search endpoint
 * Performs a SoundCloud search by name using yt-dlp.
 * Expects a query parameter 'q'.
 * Caches results to reduce redundant calls to yt-dlp.
 */
app.get('/search', async (req, res) => {
    const query = req.query.q;
    if (!query) {
        return res.status(400).json({ success: false, message: 'Search query is required.' });
    }

    console.log(`Received search request for: "${query}" (SoundCloud search via yt-dlp)`);

    const cacheKey = `search:${query}`;
    const cachedResults = searchCache.get(cacheKey);
    if (cachedResults) {
        console.log(`Returning cached search results for: "${query}"`);
        return res.json({ success: true, results: cachedResults, message: 'Results from cache.' });
    }

    // yt-dlp command to search SoundCloud and dump JSON metadata
    // Using an array for arguments is safer and preferred with spawn
    const searchArgs = [
        `scsearch10:${query}`, // Search for top 10 results on SoundCloud
        '--dump-json',         // Dump all metadata in JSON format
        '--flat-playlist',     // Do not extract videos in a playlist
        '--ignore-errors',     // Continue on download errors
        '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36', // Mimic a real browser
        '--no-check-certificate', // Disable SSL certificate validation (use with caution)
        '--socket-timeout', '60', // Set socket timeout to 60 seconds
    ];

    // Log the command and its arguments for debugging
    console.log(`Using yt-dlp command with arguments: yt-dlp ${searchArgs.join(' ')}`);

    let stdoutData = '';
    let stderrData = '';

    // Spawn a child process for yt-dlp
    const ytDlpProcess = spawn('yt-dlp', searchArgs);

    ytDlpProcess.stdout.on('data', (data) => {
        stdoutData += data.toString();
    });

    ytDlpProcess.stderr.on('data', (data) => {
        stderrData += data.toString();
    });

    ytDlpProcess.on('close', (code) => {
        if (code !== 0) {
            console.error(`yt-dlp search process exited with code ${code}`);
            console.error(`stdout for /search: ${stdoutData}`);
            console.error(`stderr for /search: ${stderrData}`);
            let errorMessage = `Failed to perform search (yt-dlp exited with code ${code}).`;

            if (stderrData.includes('No entries found')) {
                errorMessage = 'No songs found on SoundCloud for this query. Try a different name.';
            } else if (stderrData.includes('Sign in to confirm you\'re not a bot') || stderrData.includes('Please log in')) {
                errorMessage = 'SoundCloud search blocked (bot detection/login required).';
            } else if (stderrData.includes('Unable to extract') || stderrData.includes('ERROR')) {
                errorMessage = 'Could not process search results from SoundCloud. It might be a temporary issue or content restrictions.';
            } else if (stderrData.includes('timed out')) {
                errorMessage = 'SoundCloud search timed out. The server might be too slow or network issues.';
            } else if (stderrData.includes('no such option')) {
                errorMessage = `An unsupported yt-dlp option was used. Please check backend logs or update yt-dlp.`;
            } else if (stderrData.includes('RateLimitExceeded')) {
                errorMessage = 'SoundCloud rate limit exceeded. Please try again later.';
            }

            return res.status(500).json({ success: false, message: errorMessage, stderr: stderrData });
        }

        if (stderrData) {
            console.warn(`stderr for /search (non-error output): ${stderrData}`);
        }

        try {
            const rawResults = stdoutData.trim().split('\n');
            const formattedResults = [];

            console.log(`Raw yt-dlp output has ${rawResults.length} lines.`);

            for (const line of rawResults) {
                if (line.trim()) {
                    try {
                        const metadata = JSON.parse(line);
                        
                        console.log(`Processing result: Title: "${metadata.title}" | Extractor: "${metadata.extractor_key}" | URL: "${metadata.webpage_url}" | _type: "${metadata._type}" | duration: "${metadata.duration}"`);
                        
                        // Refined filtering:
                        // Ensure it's from SoundCloud AND it's not explicitly a playlist, channel, or user page.
                        // Individual tracks on SoundCloud usually have 'Soundcloud' as extractor_key
                        // or just a regular URL. Explicitly checking for _type 'video' or 'None' (default for tracks)
                        // and a duration (to confirm it's playable audio/video) and a title.
                        const isSoundCloud = (metadata.extractor_key && metadata.extractor_key.includes('Soundcloud')) || (metadata.webpage_url && metadata.webpage_url.includes('soundcloud.com'));
                        const isTrack = (metadata._type === 'video' || !metadata._type) && metadata.duration && metadata.title; 

                        if (isSoundCloud && isTrack && metadata.title && metadata.webpage_url) {
                            formattedResults.push({
                                title: metadata.title,
                                artist: metadata.uploader || metadata.channel || 'Unknown',
                                url: metadata.webpage_url,
                                thumbnail: metadata.thumbnails ? metadata.thumbnails[metadata.thumbnails.length - 1]?.url : null,
                                id: metadata.id || crypto.createHash('md5').update(metadata.webpage_url).digest('hex') // Add a unique ID for React keys
                            });
                            console.log(`Added track: ${metadata.title}`);
                        } else {
                            console.log(`Skipped result (not a track or not SoundCloud-relevant): Title: "${metadata.title}" | Extractor: "${metadata.extractor_key}" | URL: "${metadata.webpage_url}" | _type: "${metadata._type}"`);
                        }
                    } catch (parseLineError) {
                        console.warn(`Failed to parse a line of search result JSON: ${parseLineError.message} - Line: "${line.substring(0, Math.min(line.length, 200))}..."`);
                    }
                }
            }

            console.log(`Successfully found ${formattedResults.length} relevant SoundCloud results for: "${query}"`);
            
            // Cache the successful results
            searchCache.set(cacheKey, formattedResults);

            if (formattedResults.length === 0 && rawResults.length > 0) {
                // This means yt-dlp found something, but we filtered all of it out (e.g., only non-track results)
                return res.status(200).json({ success: false, message: 'No relevant SoundCloud songs found. Try a more specific query.', results: [] });
            }
            res.json({ success: true, results: formattedResults });

        } catch (parseError) {
            console.error(`Failed to parse yt-dlp search JSON or process results: ${parseError.message}`);
            res.status(500).json({ success: false, message: `Failed to process search results: ${parseError.message}` });
        }
    });
});

/**
 * /download-mp3 endpoint
 * Downloads audio from a given URL (e.g., SoundCloud) and converts it to MP3.
 * Expects a JSON body with a 'url' property.
 * Caches downloaded files to avoid re-downloading.
 */
app.post('/download-mp3', async (req, res) => {
    console.log('Backend: Received POST /download-mp3 request.');
    const { url } = req.body;
    console.log('Backend: Extracted URL from body:', url);

    if (!url) {
        return res.status(400).json({ success: false, message: 'Source URL is required for download.' });
    }

    // Create a unique hash for the URL to use as a filename, preventing duplicates
    const hash = crypto.createHash('md5').update(url).digest('hex');
    const outputFileName = `${hash}.mp3`;
    const outputFilePath = path.join(AUDIO_DIR, outputFileName);
    
    // Construct the public URL for the audio file. req.hostname will be Render's domain.
    const publicAudioUrl = `https://${req.hostname}/audio/${outputFileName}`;

    // Check if the file already exists to avoid re-downloading
    if (fs.existsSync(outputFilePath)) {
        console.log(`MP3 for URL hash ${hash} already exists. Serving existing file.`);
        // Even if file exists, try to fetch fresh metadata in case title/artist is needed
        const metadataArgs = [
            '--print-json',
            '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
            '--no-check-certificate',
            '--socket-timeout', '60',
            url
        ];
        const metadataProcess = spawn('yt-dlp', metadataArgs);
        let metaStdout = '';
        let metaStderr = '';

        metadataProcess.stdout.on('data', (data) => metaStdout += data.toString());
        metadataProcess.stderr.on('data', (data) => metaStderr += data.toString());

        metadataProcess.on('close', (code) => {
            if (code !== 0) {
                console.warn(`Error getting metadata for existing file ${url}: yt-dlp exited with code ${code}. Stderr: ${metaStderr}. Sending generic metadata.`);
                return res.json({
                    success: true,
                    message: 'Audio already processed and available, but metadata could not be fetched.',
                    audioUrl: publicAudioUrl,
                    title: `Previously Downloaded Track (ID: ${hash.substring(0, 8)})`,
                    artist: 'Unknown',
                    thumbnail: null
                });
            }
            try {
                const metadata = JSON.parse(metaStdout);
                res.json({
                    success: true,
                    message: 'Audio already processed and available!',
                    audioUrl: publicAudioUrl,
                    title: metadata.title,
                    artist: metadata.uploader || metadata.channel || 'Unknown',
                    thumbnail: metadata.thumbnails ? metadata.thumbnails[metadata.thumbnails.length - 1]?.url : null
                });
            } catch (parseMetaError) {
                console.error(`Failed to parse metadata JSON for existing file: ${parseMetaError.message}`);
                res.status(500).json({ success: false, message: 'Failed to parse metadata for existing file.' });
            }
        });
        return;
    }

    console.log(`Starting download and conversion for ${url} to ${outputFilePath}`);
    
    const downloadArgs = [
        '-x',
        '--audio-format', 'mp3',
        '-o', outputFilePath,
        '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        '--no-check-certificate',
        '--socket-timeout', '300',
        '--force-overwrites',
        url
    ];

    let downloadStdout = '';
    let downloadStderr = '';

    const downloadProcess = spawn('yt-dlp', downloadArgs);

    downloadProcess.stdout.on('data', (data) => {
        downloadStdout += data.toString();
    });

    downloadProcess.stderr.on('data', (data) => {
        downloadStderr += data.toString();
    });

    downloadProcess.on('close', (code) => {
        if (code !== 0) {
            if (fs.existsSync(outputFilePath)) {
                fs.unlinkSync(outputFilePath);
                console.log(`Cleaned up incomplete file: ${outputFilePath}`);
            }

            console.error(`yt-dlp download process exited with code ${code}`);
            console.error(`stdout for download: ${downloadStdout}`);
            console.error(`stderr for download: ${downloadStderr}`);
            let errorMessage = `Failed to download or convert (yt-dlp exited with code ${code}).`;

            if (downloadStderr.includes('Sign in to confirm you\'re not a bot') || downloadStderr.includes('Please log in')) {
                errorMessage = 'Download blocked by source website (bot detection/login required).';
            } else if (downloadStderr.includes('No such video') || downloadStderr.includes('Private video') || downloadStderr.includes('unavailable')) {
                errorMessage = 'Track not found, unavailable, or is private.';
            } else if (downloadStderr.includes('Unsupported URL')) {
                errorMessage = 'Unsupported URL for download. Please ensure it is a valid video/audio page.';
            } else if (downloadStderr.includes('timed out')) {
                errorMessage = 'Download timed out. The server might be too slow or network issues.';
            } else if (downloadStderr.includes('no such option')) {
                errorMessage = `An unsupported yt-dlp option was used. Please check backend logs or update yt-dlp.`;
            } else if (downloadStderr.includes('RateLimitExceeded')) {
                errorMessage = 'Source website rate limit exceeded. Please try again later.';
            } else if (downloadStderr.includes('ffprobe') || downloadStderr.includes('ffmpeg')) {
                errorMessage = 'Audio conversion tools (ffmpeg/ffprobe) not found or not working on server. Check server setup.';
            }
            return res.status(500).json({ success: false, message: errorMessage, stderr: downloadStderr });
        }

        if (downloadStderr) {
            console.warn(`stderr for download (non-error output): ${downloadStderr}`);
        }

        console.log(`Download/Conversion successful for ${url}. File: ${outputFilePath}`);

        const metadataAfterDownloadArgs = [
            '--print-json',
            '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
            '--no-check-certificate',
            '--socket-timeout', '60',
            url
        ];

        let finalMetaStdout = '';
        let finalMetaStderr = '';
        const finalMetadataProcess = spawn('yt-dlp', metadataAfterDownloadArgs);

        finalMetadataProcess.stdout.on('data', (data) => finalMetaStdout += data.toString());
        finalMetadataProcess.stderr.on('data', (data) => finalMetaStderr += data.toString());

        finalMetadataProcess.on('close', (metaCode) => {
            if (metaCode !== 0) {
                console.error(`exec error for metadata after download: yt-dlp exited with code ${metaCode}. Stderr: ${finalMetaStderr}`);
                return res.json({
                    success: true,
                    message: 'Audio downloaded and converted successfully, but metadata extraction failed.',
                    audioUrl: publicAudioUrl,
                    title: 'Downloaded Track (Metadata N/A)',
                    artist: 'Unknown',
                    thumbnail: null
                });
            }
            try {
                const metadata = JSON.parse(finalMetaStdout);
                res.json({
                    success: true,
                    message: 'Audio downloaded and converted successfully!',
                    audioUrl: publicAudioUrl,
                    title: metadata.title,
                    artist: metadata.uploader || metadata.channel || 'Unknown',
                    thumbnail: metadata.thumbnails ? metadata.thumbnails[metadata.thumbnails.length - 1]?.url : null
                });
            } catch (parseMetaError) {
                console.error(`Failed to parse metadata JSON after download: ${parseMetaError.message}`);
                res.status(500).json({ success: false, message: 'Failed to parse metadata after download.' });
            }
        });
    });
});

// Start the server
app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
    console.log(`Audio files will be stored in: ${AUDIO_DIR}`);
});
