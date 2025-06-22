const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 10000; // Use Render's assigned port or 10000 for local

app.use(cors()); // Enable CORS for all routes
app.use(express.json()); // For parsing application/json

// Ensure 'audio' directory exists
const audioDir = path.join(__dirname, 'audio');
if (!fs.existsSync(audioDir)) {
    fs.mkdirSync(audioDir);
}

// Search endpoint using yt-dlp
app.get('/search', async (req, res) => {
    const query = req.query.q;
    if (!query) {
        return res.status(400).json({ success: false, message: 'Search query is required.' });
    }

    console.log(`Received search request for: "${query}"`);

    const command = `yt-dlp --dump-json "ytsearch:${query}"`;

    exec(command, { maxBuffer: 1024 * 1024 * 5 }, (error, stdout, stderr) => {
        if (error) {
            console.error(`exec error: ${error}`);
            // Attempt to parse stderr for more specific error message if it's JSON
            try {
                const errorJson = JSON.parse(stderr);
                return res.status(500).json({ success: false, message: errorJson.message || 'Failed to search YouTube.', details: stderr });
            } catch (parseError) {
                return res.status(500).json({ success: false, message: `Failed to search YouTube: ${error.message}`, details: stderr });
            }
        }

        if (stderr) {
            console.warn(`stderr: ${stderr}`);
            // Sometimes warnings come in stderr, but if it's the only output, might indicate an issue
            // Still proceed if stdout has data, otherwise return error
            if (!stdout.trim()) {
                return res.status(500).json({ success: false, message: `Search command stderr: ${stderr}` });
            }
        }

        try {
            const lines = stdout.trim().split('\n');
            const results = lines.map(line => JSON.parse(line));

            console.log(`Raw yt-dlp search results (entries count): ${results.length}`);
            console.log(`Raw yt-dlp search results (first 5 entries): ${JSON.stringify(results.slice(0, 5), null, 2)}`); // Log first 5 for inspection

            const formattedResults = results.map(entry => {
                // Ensure the 'url' property is included here
                return {
                    title: entry.title,
                    artist: entry.uploader || entry.channel || 'Unknown',
                    youtubeId: entry.id,
                    url: entry.url, // THIS IS THE CRITICAL ADDITION
                    thumbnail: entry.thumbnails?.[0]?.url || `https://i.ytimg.com/vi/${entry.id}/hqdefault.jpg`
                };
            }).filter(item => item.url && item.title); // Filter out entries without a valid URL or title

            console.log(`Found ${formattedResults.length} formatted results after filtering.`);

            res.json({ success: true, results: formattedResults });

        } catch (parseError) {
            console.error(`Failed to parse yt-dlp JSON output: ${parseError}`);
            res.status(500).json({ success: false, message: 'Failed to parse search results.', details: parseError.message });
        }
    });
});

// Download and convert to MP3 endpoint
app.post('/download-mp3', async (req, res) => {
    console.log('Backend: Received POST /download-mp3 request. Raw body:', req.body);
    const { url } = req.body;
    console.log('Backend: Extracted URL from body:', url);

    if (!url) {
        return res.status(400).json({ success: false, message: 'YouTube URL is required.' });
    }

    const videoId = new URL(url).searchParams.get('v');
    if (!videoId) {
        return res.status(400).json({ success: false, message: 'Invalid YouTube URL: missing video ID.' });
    }

    const outputFilePath = path.join(audioDir, `${videoId}.mp3`);
    const publicAudioUrl = `https://${req.hostname}/audio/${videoId}.mp3`; // Construct public URL

    // Check if the MP3 already exists
    if (fs.existsSync(outputFilePath)) {
        console.log(`MP3 for ${videoId} already exists. Serving existing file.`);
        // To get title/artist for existing file, you'd typically store it in a DB
        // For now, let's just use placeholder or re-extract (less efficient)
        // Or, we can modify the search result to include the audioUrl directly if it's in library
        return res.json({
            success: true,
            message: 'Audio already processed and available.',
            audioUrl: publicAudioUrl,
            title: `Previously Downloaded Track (${videoId})`, // Placeholder
            artist: 'Unknown' // Placeholder
        });
    }

    console.log(`Starting download for ${url}`);
    // Download and convert using yt-dlp
    // -x: extract audio
    // --audio-format mp3: specify mp3 format
    // -o: output filename template
    const command = `yt-dlp -x --audio-format mp3 -o "${outputFilePath}" "${url}"`;

    exec(command, { maxBuffer: 1024 * 1024 * 10 }, async (error, stdout, stderr) => { // Increased maxBuffer
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
        const metadataCommand = `yt-dlp --print-json "${url}"`;
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
                    thumbnail: metadata.thumbnails?.[0]?.url // Optional: pass thumbnail back
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
