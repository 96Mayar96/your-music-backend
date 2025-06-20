const express = require('express');
const cors = require('cors');
const { youtubeDl } = require('youtube-dl-exec');
const ffmpeg = require('fluent-ffmpeg');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

// --- Configuration ---
// On Render (using Dockerfile), these binaries will be installed into the container's PATH.
// For local testing, ensure `yt-dlp` and `ffmpeg` are installed and in your system's PATH.
const YTDLP_BIN_PATH = process.env.YTDLP_BIN || 'yt-dlp';
const FFMPEG_BIN_PATH = process.env.FFMPEG_BIN || 'ffmpeg';

// Set FFmpeg paths for fluent-ffmpeg
ffmpeg.setFfmpegPath(FFMPEG_BIN_PATH);
ffmpeg.setFfprobePath(FFMPEG_BIN_PATH); // ffprobe is usually part of the ffmpeg package

const app = express();
// Use process.env.PORT provided by Render or default to 3000 for local development
const port = process.env.PORT || 3000;

// Determine the base URL for serving files.
const BASE_URL = process.env.RENDER_EXTERNAL_HOSTNAME
  ? `https://${process.env.RENDER_EXTERNAL_HOSTNAME}`
  : `http://localhost:${port}`;

// --- Middleware ---
app.use(cors()); // Enable CORS for all origins (important for your frontend)
app.use(express.json()); // For parsing application/json bodies

// Directory to store downloaded MP3s temporarily
const downloadsDir = path.join(__dirname, 'downloads');
if (!fs.existsSync(downloadsDir)) {
    fs.mkdirSync(downloadsDir, { recursive: true });
    console.log(`Created downloads directory: ${downloadsDir}`);
}

// Serve static files from the 'downloads' directory
// This allows your frontend to fetch the MP3s directly from your backend's URL
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
        // Step 1: Get video metadata using yt-dlp
        console.log('Fetching video info...');
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
});