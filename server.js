const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto'); // For hashing URLs

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

const audioDir = path.join(__dirname, 'audio');
if (!fs.existsSync(audioDir)) {
    fs.mkdirSync(audioDir);
}

// NEW /search endpoint - Performs a SoundCloud search by name
app.get('/search', async (req, res) => {
    const query = req.query.q; // Expecting a search query (song name)
    if (!query) {
        return res.status(400).json({ success: false, message: 'Search query is required.' });
    }

    console.log(`Received search request for: "${query}" (SoundCloud search via yt-dlp)`);

    // Removed --prefer-https
    const command = `yt-dlp --dump-json --flat-playlist --default-search "scsearch" --max-downloads 1000 --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36" --no-check-certificate --socket-timeout 300 "${query}"`;

    exec(command, { maxBuffer: 1024 * 1024 * 50 }, (error, stdout, stderr) => {
        if (error) {
            console.error(`exec error for /search: ${error}`);
            console.error(`stderr for /search: ${stderr}`);
            let errorMessage = `Failed to perform search: ${error.message}`;
            if (stderr.includes('No entries found')) {
                errorMessage = 'No songs found on SoundCloud for this query. Try a different name.';
            } else if (stderr.includes('Sign in to confirm you’re not a bot')) {
                errorMessage = 'Search blocked by SoundCloud (bot detection/login required).';
            } else if (stderr.includes('ERROR: Unable to extract')) {
                errorMessage = 'Could not process search results from SoundCloud. It might be a temporary issue.';
            } else if (stderr.includes('timed out')) {
                errorMessage = 'SoundCloud search timed out. The server might be too slow or network issues.';
            } else if (stderr.includes('no such option')) { // Catch new errors about unsupported options
                 errorMessage = `An unsupported yt-dlp option was used. Please check backend logs.`;
            }
            return res.status(500).json({ success: false, message: errorMessage, stderr: stderr });
        }
        if (stderr) {
            console.warn(`stderr for /search (non-error): ${stderr}`);
        }

        try {
            const rawResults = stdout.trim().split('\n');
            const formattedResults = [];

            for (const line of rawResults) {
                if (line.trim()) {
                    try {
                        const metadata = JSON.parse(line);
                        if (metadata.extractor_key && metadata.extractor_key.includes('Soundcloud')) {
                            formattedResults.push({
                                title: metadata.title,
                                artist: metadata.uploader || metadata.channel || 'Unknown',
                                url: metadata.webpage_url,
                                thumbnail: metadata.thumbnails ? metadata.thumbnails[metadata.thumbnails.length - 1]?.url : null
                            });
                        }
                    } catch (parseLineError) {
                        console.warn(`Failed to parse a line of search result JSON: ${parseLineError} - Line: ${line}`);
                    }
                }
            }

            console.log(`Successfully found ${formattedResults.length} SoundCloud results for: ${query}`);
            if (formattedResults.length === 0 && rawResults.length > 0) {
                 return res.status(200).json({ success: false, message: 'No relevant SoundCloud songs found. Try a more specific query.', results: [] });
            }
            res.json({ success: true, results: formattedResults });

        } catch (parseError) {
            console.error(`Failed to parse yt-dlp search JSON: ${parseError}`);
            res.status(500).json({ success: false, message: `Failed to process search results: ${parseError.message}` });
        }
    });
});


// Download and convert to MP3 endpoint
app.post('/download-mp3', async (req, res) => {
    console.log('Backend: Received POST /download-mp3 request. Raw body:', req.body);
    const { url } = req.body;
    console.log('Backend: Extracted URL from body:', url);

    if (!url) {
        return res.status(400).json({ success: false, message: 'Source URL is required for download.' });
    }

    const hash = crypto.createHash('md5').update(url).digest('hex');
    const outputFileName = `${hash}.mp3`;
    const outputFilePath = path.join(audioDir, outputFileName);
    const publicAudioUrl = `https://${req.hostname}/audio/${outputFileName}`;

    if (fs.existsSync(outputFilePath)) {
        console.log(`MP3 for URL hash ${hash} already exists. Serving existing file.`);
        const metadataCommand = `yt-dlp --print-json --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36" --no-check-certificate --socket-timeout 300 "${url}"`; // Removed --prefer-https
        exec(metadataCommand, { maxBuffer: 1024 * 1024 * 5 }, (metaError, metaStdout, metaStderr) => {
            if (metaError) {
                console.warn(`Error getting metadata for existing file ${url}: ${metaError.message}`);
                return res.json({
                    success: true,
                    message: 'Audio already processed and available.',
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
                    message: 'Audio already processed and available.',
                    audioUrl: publicAudioUrl,
                    title: metadata.title,
                    artist: metadata.uploader || metadata.channel || 'Unknown',
                    thumbnail: metadata.thumbnails ? metadata.thumbnails[metadata.thumbnails.length - 1]?.url : null
                });
            } catch (parseMetaError) {
                console.error(`Failed to parse metadata JSON for existing file: ${parseMetaError}`);
                res.json({
                    success: true,
                    message: 'Audio already processed, but metadata refresh failed.',
                    audioUrl: publicAudioUrl,
                    title: `Previously Downloaded Track (ID: ${hash.substring(0, 8)})`,
                    artist: 'Unknown',
                    thumbnail: null
                });
            }
        });
        return;
    }

    console.log(`Starting download for ${url}`);
    // Removed --prefer-https
    const command = `yt-dlp -x --audio-format mp3 -o "${outputFilePath}" --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36" --no-check-certificate --socket-timeout 300 "${url}"`;

    exec(command, { maxBuffer: 1024 * 1024 * 10 }, async (error, stdout, stderr) => {
        if (error) {
            console.error(`exec error for download: ${error}`);
            console.error(`stdout: ${stdout}`);
            console.error(`stderr: ${stderr}`);
            let errorMessage = `Failed to download or convert: ${error.message}`;
            if (stderr.includes('Sign in to confirm you’re not a bot')) {
                errorMessage = 'Download blocked by source website (bot detection/login required).';
            } else if (stderr.includes('No such video') || stderr.includes('Private video') || stderr.includes('unavailable')) {
                errorMessage = 'Track not found, unavailable, or is private.';
            } else if (stderr.includes('Unsupported URL')) {
                errorMessage = 'Unsupported URL for download. Please ensure it is a valid video/audio page.';
            } else if (stderr.includes('timed out')) {
                errorMessage = 'Download timed out. The server might be too slow or network issues.';
            } else if (stderr.includes('no such option')) { // Catch new errors about unsupported options
                 errorMessage = `An unsupported yt-dlp option was used. Please check backend logs.`;
            }
            return res.status(500).json({ success: false, message: errorMessage, stderr: stderr });
        }
        if (stderr) {
            console.warn(`stderr for download (non-error): ${stderr}`);
        }

        console.log(`Download/Conversion successful for ${url}`);

        // After successful download, extract metadata using yt-dlp --print-json to send back
        const metadataCommand = `yt-dlp --print-json --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36" --no-check-certificate --socket-timeout 300 "${url}"`; // Removed --prefer-https
        exec(metadataCommand, { maxBuffer: 1024 * 1024 * 5 }, (metaError, metaStdout, metaStderr) => {
            if (metaError) {
                console.error(`exec error for metadata after download: ${metaError}`);
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
