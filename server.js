const express = require('express');
const cors = require('cors');
const { youtubeDl } = require('youtube-dl-exec');
const ffmpeg = require('fluent-ffmpeg');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

// --- Configuration ---
const YTDLP_BIN_PATH = process.env.YTDLP_BIN || 'yt-dlp';
const FFMPEG_BIN_PATH = process.env.FFMPEG_BIN || 'ffmpeg';

// Set FFmpeg paths for fluent-ffmpeg
ffmpeg.setFfmpegPath(FFMPEG_BIN_PATH);
ffmpeg.setFfprobePath(FFMPEG_BIN_PATH);

const app = express();
const port = process.env.PORT || 3000;

const BASE_URL = process.env.RENDER_EXTERNAL_HOSTNAME
  ? `https://${process.env.RENDER_EXTERNAL_HOSTNAME}`
  : `http://localhost:${port}`;

// Directory to store downloaded MP3s temporarily
const downloadsDir = path.join(__dirname, 'downloads');
if (!fs.existsSync(downloadsDir)) {
    fs.mkdirSync(downloadsDir, { recursive: true });
    console.log(`Created downloads directory: ${downloadsDir}`);
}

// --- Middleware ---
app.use(cors()); // Enable CORS for all origins (important for your frontend)
app.use(express.json()); // For parsing application/json bodies

// Serve static files from the 'downloads' directory
app.use('/downloads', express.static(downloadsDir, {
    setHeaders: (res, path, stat) => {
        res.set('Cache-Control', 'public, max-age=31536000'); // Cache for 1 year
    }
}));

// --- Routes ---

// Simple health check route
app.get('/', (req, res) => {
    res.send('Your Music Backend is running!');
});

// NEW: Endpoint to search YouTube for videos
app.get('/search', async (req, res) => {
    const searchQuery = req.query.q;
    if (!searchQuery) {
        return res.status(400).json({ success: false, message: 'Search query is required.' });
    }

    console.log(`Received search request for: "${searchQuery}"`);
    // Inside app.get('/search', ...)
try {
    const searchResultsRaw = await youtubeDl(searchQuery, {
        dumpSingleJson: true,
        flatPlaylist: true,
        defaultSearch: 'ytsearch',
        noWarnings: true,
        callHome: false,
        noCheckCertificates: true,
        exec: {
            ytDlpPath: YTDLP_BIN_PATH
        }
    });

    console.log('Raw yt-dlp search results (entries count):', searchResultsRaw.entries ? searchResultsRaw.entries.length : 0);
    // CRITICAL: Log the full (or large sample) raw results if any, so we can see what yt-dlp actually returned
    if (searchResultsRaw.entries && searchResultsRaw.entries.length > 0) {
        console.log('Raw yt-dlp search results (first 5 entries):', JSON.stringify(searchResultsRaw.entries.slice(0, 5), null, 2));
    } else {
        console.log('Raw yt-dlp search results: No entries found by yt-dlp.');
    }

    const formattedResults = (searchResultsRaw.entries || [])
        .filter(entry => {
            const isValidUrl = entry.webpage_url && (entry.webpage_url.includes('youtube.com/watch') || entry.webpage_url.includes('youtu.be/'));
            if (!isValidUrl) {
                console.log('Filtered out non-video entry:', entry.webpage_url || entry.title || 'Unknown entry');
            }
            return isValidUrl;
        })
        .map(entry => ({
            title: entry.title,
            artist: entry.uploader || entry.channel || 'Unknown',
            url: entry.webpage_url,
            youtubeId: entry.id,
            thumbnail: entry.thumbnail || `https://i.ytimg.com/vi/${entry.id}/hqdefault.jpg`
        }))
        .slice(0, 15);

    console.log(`Found ${formattedResults.length} formatted results after filtering.`);
    // ... rest of your code ...
} catch (error) {
    // ... error handling ...
}


// Endpoint to get YouTube video metadata (title, artist)
app.get('/info', async (req, res) => {
    const videoURL = req.query.url;
    if (!videoURL) {
        return res.status(400).json({ success: false, message: 'YouTube URL is required.' });
    }
    if (!videoURL.includes('youtube.com') && !videoURL.includes('youtu.be')) {
        return res.status(400).json({ success: false, message: 'Invalid YouTube URL provided.' });
    }

    try {
        const videoInfo = await youtubeDl(videoURL, {
            dumpSingleJson: true,
            noWarnings: true,
            callHome: false,
            noCheckCertificates: true,
            preferFreeFormats: true,
            youtubeSkipDashManifest: true,
            format: 'bestaudio', // Only get audio format info
            exec: {
                ytDlpPath: YTDLP_BIN_PATH
            }
        });

        res.json({
            success: true,
            title: videoInfo.title || 'Unknown Title',
            artist: videoInfo.artist || videoInfo.uploader || 'Unknown Artist',
            duration: videoInfo.duration_string || 'N/A',
            thumbnail: videoInfo.thumbnail || `https://i.ytimg.com/vi/${videoInfo.id}/hqdefault.jpg`,
            youtubeId: videoInfo.id
        });

    } catch (error) {
        console.error("Error fetching video info:", error);
        res.status(500).json({ success: false, message: error.message || 'Failed to fetch video information.' });
    }
});

// Endpoint to download and convert YouTube video to MP3
app.post('/download-mp3', async (req, res) => {
    const { url } = req.body;
    if (!url) {
        return res.status(400).json({ success: false, message: 'YouTube URL is required.' });
    }

    // Basic URL validation
    if (!url.includes('youtube.com') && !url.includes('youtu.be')) {
        return res.status(400).json({ success: false, message: 'Invalid YouTube URL provided.' });
    }

    const uniqueId = uuidv4();
    const mp3FilePath = path.join(downloadsDir, `${uniqueId}.mp3`);

    console.log(`Received download request for: ${url}`);
    console.log(`Output path for MP3: ${mp3FilePath}`);

    try {
        // Step 1: Get video metadata using yt-dlp (re-fetch to be safe, or pass from frontend)
        // Frontend now passes necessary info, but backend will ensure it's correct
        const videoInfo = await youtubeDl(url, {
            dumpSingleJson: true,
            noWarnings: true,
            callHome: false,
            noCheckCertificates: true,
            preferFreeFormats: true,
            youtubeSkipDashManifest: true,
            format: 'bestaudio', // Request best audio format for info
            exec: {
                ytDlpPath: YTDLP_BIN_PATH
            }
        });

        const title = videoInfo.title || 'Unknown Title';
        const artist = videoInfo.artist || videoInfo.uploader || 'Unknown Artist';
        console.log(`Found video: "${title}" by "${artist}"`);

        // Step 2: Stream audio directly to ffmpeg for conversion
        console.log('Starting audio download stream and conversion to MP3...');
        await new Promise((resolve, reject) => {
            const audioProcess = youtubeDl.exec(url, {
                format: 'bestaudio', // Get the direct audio stream URL
                printStderr: true,
                getUrl: true, // Only print the URL, don't download
                exec: {
                    ytDlpPath: YTDLP_BIN_PATH
                }
            });

            let audioStreamUrl = '';
            audioProcess.stdout.on('data', (data) => {
                audioStreamUrl += data.toString().trim();
            });

            audioProcess.on('close', (code) => {
                if (code === 0 && audioStreamUrl.startsWith('http')) {
                    console.log('Audio stream URL obtained:', audioStreamUrl);
                    ffmpeg(audioStreamUrl)
                        .audioCodec('libmp3lame')
                        .audioBitrate(128) // You can adjust bitrate (e.g., 192, 256, 320)
                        .toFormat('mp3')
                        .save(mp3FilePath)
                        .on('end', () => {
                            console.log('FFmpeg conversion finished!');
                            resolve();
                        })
                        .on('error', (err, stdout, stderr) => {
                            console.error('FFmpeg error:', err.message);
                            console.error('FFmpeg stdout:', stdout);
                            console.error('FFmpeg stderr:', stderr);
                            reject(new Error(`FFmpeg conversion failed: ${err.message}`));
                        });
                } else {
                    reject(new Error(`yt-dlp failed to get stream URL (exit code: ${code}). Stderr: ${audioProcess.stderr.read()?.toString()}`));
                }
            });

            audioProcess.stderr.on('data', (data) => {
                console.error('yt-dlp stderr:', data.toString());
            });
        });

        // Construct the full public URL for the MP3 file
        const audioUrl = `${BASE_URL}/downloads/${uniqueId}.mp3`;

        res.json({
            success: true,
            message: 'Download and conversion successful!',
            title: title,
            artist: artist,
            audioUrl: audioUrl // Send the full public URL to the frontend
        });

    } catch (error) {
        console.error("Server error during download/conversion:", error);
        // Delete partially created files if any
        if (fs.existsSync(mp3FilePath)) {
            fs.unlinkSync(mp3FilePath);
            console.log(`Cleaned up partial file: ${mp3FilePath}`);
        }
        res.status(500).json({ success: false, message: error.message || 'An unexpected error occurred.' });
    }
});

// Start the server
app.listen(port, () => {
    console.log(`Backend server listening at ${BASE_URL}`);
})});
