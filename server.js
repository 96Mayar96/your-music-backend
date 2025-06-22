const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
// const { google } = require('googleapis'); // No longer needed for direct URL processing

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

const audioDir = path.join(__dirname, 'audio');
if (!fs.existsSync(audioDir)) {
    fs.mkdirSync(audioDir);
}

// Removed YouTube Data API initialization as we're switching to direct URL processing

// NEW /info endpoint (formerly /search) - Extracts metadata from a given URL
app.get('/info', async (req, res) => {
    const url = req.query.url; // Expecting a direct URL as the query parameter
    if (!url) {
        return res.status(400).json({ success: false, message: 'URL is required for information retrieval.' });
    }

    console.log(`Received info request for URL: "${url}" (using yt-dlp)`);

    // Use yt-dlp to get video metadata as JSON
    // --dump-json prints the full metadata as JSON
    // --no-playlist prevents downloading entire playlists if URL is a playlist
    const command = `yt-dlp --dump-json --no-playlist --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36" "${url}"`;

    exec(command, { maxBuffer: 1024 * 1024 * 5 }, (error, stdout, stderr) => {
        if (error) {
            console.error(`exec error for /info: ${error}`);
            console.error(`stderr for /info: ${stderr}`);
            // Attempt to parse stderr for more specific yt-dlp error messages
            let errorMessage = `Failed to get info for URL: ${error.message}`;
            if (stderr.includes('Sign in to confirm you’re not a bot')) {
                errorMessage = 'Blocked by source website (bot detection/login required).';
            } else if (stderr.includes('No such video') || stderr.includes('Private video')) {
                errorMessage = 'Video not found or is private.';
            } else if (stderr.includes('Unsupported URL')) {
                errorMessage = 'Unsupported URL. Please ensure it is a valid video/audio page.';
            }
            return res.status(500).json({ success: false, message: errorMessage, stderr: stderr });
        }
        if (stderr) {
            console.warn(`stderr for /info (non-error): ${stderr}`);
        }

        try {
            const metadata = JSON.parse(stdout);
            console.log(`Successfully retrieved metadata for: ${metadata.title}`);

            const formattedResult = {
                title: metadata.title,
                artist: metadata.uploader || metadata.channel || 'Unknown',
                // For direct URL downloads, youtubeId might not be relevant if not YouTube.
                // We can use a combination of extractor + id or just the URL as a unique identifier.
                // For simplicity, let's keep youtubeId for potential future YouTube specific handling,
                // but rely on `url` for actual download.
                youtubeId: metadata.extractor_key === 'Youtube' ? metadata.id : metadata.webpage_url_basename || metadata.id,
                url: metadata.webpage_url, // Use the webpage_url to ensure it's the original source URL
                thumbnail: metadata.thumbnails ? metadata.thumbnails[metadata.thumbnails.length - 1]?.url : null // Get the highest quality thumbnail
            };

            res.json({ success: true, results: [formattedResult] }); // Return as an array for consistency with previous search results
        } catch (parseError) {
            console.error(`Failed to parse yt-dlp info JSON: ${parseError}`);
            res.status(500).json({ success: false, message: `Failed to parse metadata from URL: ${parseError.message}` });
        }
    });
});


// Download and convert to MP3 endpoint (uses yt-dlp for actual download)
app.post('/download-mp3', async (req, res) => {
    console.log('Backend: Received POST /download-mp3 request. Raw body:', req.body);
    const { url } = req.body; // URL should now come from frontend based on info results
    console.log('Backend: Extracted URL from body:', url);

    if (!url) {
        return res.status(400).json({ success: false, message: 'Source URL is required for download.' });
    }

    // Attempt to create a unique file name based on URL hash or a simpler approach
    // For simplicity, let's use a hashed version of the URL to ensure uniqueness and avoid invalid characters
    const crypto = require('crypto');
    const hash = crypto.createHash('md5').update(url).digest('hex');
    const outputFileName = `${hash}.mp3`;
    const outputFilePath = path.join(audioDir, outputFileName);
    const publicAudioUrl = `https://${req.hostname}/audio/${outputFileName}`;

    // Check if the MP3 already exists using the hashed name
    if (fs.existsSync(outputFilePath)) {
        console.log(`MP3 for URL hash ${hash} already exists. Serving existing file.`);
        // Try to get existing metadata if available, otherwise return placeholders
        // In a real app, you might store metadata in a DB with the hash
        return res.json({
            success: true,
            message: 'Audio already processed and available.',
            audioUrl: publicAudioUrl,
            title: `Previously Downloaded Track (ID: ${hash.substring(0, 8)})`, // Placeholder
            artist: 'Unknown', // Placeholder
            thumbnail: null // Placeholder
        });
    }

    console.log(`Starting download for ${url}`);
    // yt-dlp for actual download and conversion
    const command = `yt-dlp -x --audio-format mp3 -o "${outputFilePath}" --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36" "${url}"`;

    exec(command, { maxBuffer: 1024 * 1024 * 10 }, async (error, stdout, stderr) => {
        if (error) {
            console.error(`exec error for download: ${error}`);
            console.error(`stdout: ${stdout}`);
            console.error(`stderr: ${stderr}`);
            let errorMessage = `Failed to download or convert: ${error.message}`;
            if (stderr.includes('Sign in to confirm you’re not a bot')) {
                errorMessage = 'Download blocked by source website (bot detection/login required).';
            } else if (stderr.includes('No such video') || stderr.includes('Private video')) {
                errorMessage = 'Video not found or is private.';
            } else if (stderr.includes('Unsupported URL')) {
                errorMessage = 'Unsupported URL for download. Please ensure it is a valid video/audio page.';
            }
            return res.status(500).json({ success: false, message: errorMessage, stderr: stderr });
        }
        if (stderr) {
            console.warn(`stderr for download (non-error): ${stderr}`);
        }

        console.log(`Download/Conversion successful for ${url}`);

        // After successful download, extract metadata using yt-dlp --print-json to send back
        // This second call ensures we get metadata for the *downloaded* track, which might be different
        // from the initial info call if the URL was redirected etc.
        const metadataCommand = `yt-dlp --print-json --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36" "${url}"`;
        exec(metadataCommand, { maxBuffer: 1024 * 1024 * 5 }, (metaError, metaStdout, metaStderr) => {
            if (metaError) {
                console.error(`exec error for metadata after download: ${metaError}`);
                // Continue despite metadata error, as download was successful
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
                const metadata = JSON.parse(metaStdout);
                res.json({
                    success: true,
                    message: 'Audio downloaded and converted successfully!',
                    audioUrl: publicAudioUrl,
                    title: metadata.title,
                    artist: metadata.uploader || metadata.channel || 'Unknown',
                    thumbnail: metadata.thumbnails ? metadata.thumbnails[metadata.thumbnails.length - 1]?.url : null
                });
            } catch (parseMetaError) {
                console.error(`Failed to parse metadata JSON after download: ${parseMetaError}`);
                res.status(500).json({ success: false, message: 'Failed to parse metadata after download.' });
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
