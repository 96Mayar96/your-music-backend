const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const { google } = require('googleapis'); // Import googleapis library

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

const audioDir = path.join(__dirname, 'audio');
if (!fs.existsSync(audioDir)) {
    fs.mkdirSync(audioDir);
}

// Initialize YouTube Data API
// IMPORTANT: For production, store this securely as an environment variable on Render, not directly in code.
// For now, replace 'YOUR_YOUTUBE_API_KEY_HERE' with the key you generated.
const youtube = google.youtube({
    version: 'v3',
    auth: process.env.YOUTUBE_API_KEY || 'AIzaSyD-JYQR3X32KMqMsADuixw62etY8Y4SbfA' // Use env var if available, else hardcode for now
});


// Search endpoint using YouTube Data API
app.get('/search', async (req, res) => {
    const query = req.query.q;
    if (!query) {
        return res.status(400).json({ success: false, message: 'Search query is required.' });
    }

    console.log(`Received search request for: "${query}" (using YouTube Data API)`);

    try {
        const response = await Youtube.list({
            q: query,
            part: 'snippet',
            type: 'video',
            maxResults: 15, // Get up to 15 results
            videoEmbeddable: 'true' // Ensure videos can be embedded/played
        });

        const items = response.data.items;
        if (!items || items.length === 0) {
            console.log('No results found from YouTube Data API.');
            return res.json({ success: true, results: [] });
        }

        const formattedResults = items.map(item => ({
            title: item.snippet.title,
            artist: item.snippet.channelTitle || 'Unknown',
            youtubeId: item.id.videoId,
            // Construct YouTube URL directly from videoId
            url: `youtu.be/...2${item.id.videoId}`,
            thumbnail: item.snippet.thumbnails.high.url || `https://i.ytimg.com/vi/${item.id.videoId}/hqdefault.jpg`
        }));

        console.log(`Found ${formattedResults.length} formatted results from YouTube Data API.`);
        res.json({ success: true, results: formattedResults });

    } catch (error) {
        console.error("YouTube Data API search error:", error.message);
        // Log more details if available
        if (error.response && error.response.data) {
            console.error("API Error Details:", error.response.data);
        }
        res.status(500).json({ success: false, message: `Failed to search YouTube (API Error): ${error.message}` });
    }
});


// Download and convert to MP3 endpoint (still uses yt-dlp)
app.post('/download-mp3', async (req, res) => {
    console.log('Backend: Received POST /download-mp3 request. Raw body:', req.body);
    const { url } = req.body; // URL should now come from frontend based on YouTube Data API results
    console.log('Backend: Extracted URL from body:', url);

    if (!url) {
        return res.status(400).json({ success: false, message: 'YouTube URL is required.' });
    }

    const videoId = new URL(url).searchParams.get('v');
    if (!videoId) {
        return res.status(400).json({ success: false, message: 'Invalid YouTube URL: missing video ID.' });
    }

    const outputFilePath = path.join(audioDir, `${videoId}.mp3`);
    const publicAudioUrl = `https://${req.hostname}/audio/${videoId}.mp3`;

    // Check if the MP3 already exists
    if (fs.existsSync(outputFilePath)) {
        console.log(`MP3 for ${videoId} already exists. Serving existing file.`);
        return res.json({
            success: true,
            message: 'Audio already processed and available.',
            audioUrl: publicAudioUrl,
            title: `Previously Downloaded Track (${videoId})`, // Placeholder
            artist: 'Unknown' // Placeholder
        });
    }

    console.log(`Starting download for ${url}`);
    // yt-dlp for actual download (might still face bot detection, but less likely for direct URLs than search)
    const command = `yt-dlp -x --audio-format mp3 -o "${outputFilePath}" --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36" "${url}"`;

    exec(command, { maxBuffer: 1024 * 1024 * 10 }, async (error, stdout, stderr) => {
        if (error) {
            console.error(`exec error for download: ${error}`);
            console.error(`stdout: ${stdout}`);
            console.error(`stderr: ${stderr}`);
            return res.status(500).json({ success: false, message: `Failed to download or convert: ${error.message}. Stderr: ${stderr}` });
        }
        if (stderr) {
            console.warn(`stderr for download: ${stderr}`);
        }

        console.log(`Download/Conversion successful for ${url}`);

        // After successful download, extract metadata using yt-dlp to send back
        const metadataCommand = `yt-dlp --print-json --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36" "${url}"`;
        exec(metadataCommand, { maxBuffer: 1024 * 1024 * 5 }, (metaError, metaStdout, metaStderr) => {
            if (metaError) {
                console.error(`exec error for metadata: ${metaError}`);
                return res.status(500).json({ success: false, message: `Failed to get metadata: ${metaError.message}` });
            }
            try {
                const metadata = JSON.parse(metaStdout);
                res.json({
                    success: true,
                    message: 'Audio downloaded and converted successfully!',
                    audioUrl: publicAudioUrl,
                    title: metadata.title,
                    artist: metadata.uploader || metadata.channel || 'Unknown',
                    thumbnail: metadata.thumbnails?.[0]?.url
                });
            } catch (parseMetaError) {
                console.error(`Failed to parse metadata JSON: ${parseMetaError}`);
                res.status(500).json({ success: false, message: 'Failed to parse metadata.' });
            }
        });
    });
});

// Serve static audio files
app.use('/audio', express.static(audioDir));

app.get('/', (req, res) => {
    res.send('Music Player Backend is running!');
});

app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
