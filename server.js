const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto'); // For hashing URLs

const app = express();
const PORT = process.env.PORT || 10000;

// Middleware
app.use(cors({
    origin: ['https://96mayar96.github.io', 'http://localhost:3000', 'http://localhost:3001'],
    credentials: true
})); // Enable CORS for specific origins
app.use(express.json()); // Parse JSON request bodies

// Directory to store audio files
const audioDir = path.join(__dirname, 'audio');
if (!fs.existsSync(audioDir)) {
    console.log(`Creating audio directory: ${audioDir}`);
    fs.mkdirSync(audioDir);
}

// Serve static audio files from the 'audio' directory
app.use('/audio', express.static(audioDir));

// Root endpoint for a basic status check
app.get('/', (req, res) => {
    res.send('Music Player Backend is running! Audio directory created if needed.');
});

/**
 * NEW /search endpoint
 * Performs a SoundCloud search by name using yt-dlp.
 * Expects a query parameter 'q'.
 */
app.get('/search', async (req, res) => {
    const query = req.query.q; // Expecting a search query (song name)
    if (!query) {
        return res.status(400).json({ success: false, message: 'Search query is required.' });
    }

    console.log(`Received search request for: "${query}" (SoundCloud search via yt-dlp)`);

    // Use scsearch: prefix method which is specifically designed for SoundCloud searches in yt-dlp
    const command = `yt-dlp --dump-json --flat-playlist --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36" --no-check-certificate --socket-timeout 60 "scsearch:${query}"`;
    console.log(`Using command: ${command}`);

    exec(command, { maxBuffer: 1024 * 1024 * 50 }, (error, stdout, stderr) => {
        if (error) {
            console.error(`exec error for /search: ${error.message}`);
            console.error(`stderr for /search: ${stderr}`);
            let errorMessage = `Failed to perform search: ${error.message}`;

            if (stderr.includes('No entries found')) {
                errorMessage = 'No songs found on SoundCloud for this query. Try a different name.';
            } else if (stderr.includes('Sign in to confirm you\'re not a bot') || stderr.includes('Please log in')) {
                errorMessage = 'SoundCloud search blocked (bot detection/login required).';
            } else if (stderr.includes('Unable to extract') || stderr.includes('ERROR')) {
                errorMessage = 'Could not process search results from SoundCloud. It might be a temporary issue or content restrictions.';
            } else if (stderr.includes('timed out')) {
                errorMessage = 'SoundCloud search timed out. The server might be too slow or network issues.';
            } else if (stderr.includes('no such option')) {
                errorMessage = `An unsupported yt-dlp option was used. Please check backend logs or update yt-dlp.`;
            } else if (stderr.includes('RateLimitExceeded')) {
                errorMessage = 'SoundCloud rate limit exceeded. Please try again later.';
            }

            return res.status(500).json({ success: false, message: errorMessage, stderr: stderr });
        }
        if (stderr) {
            console.warn(`stderr for /search (non-error output): ${stderr}`);
        }

        try {
            const rawResults = stdout.trim().split('\n');
            const formattedResults = [];

            console.log(`Raw yt-dlp output has ${rawResults.length} lines`);
            console.log(`First few lines of raw output:`, rawResults.slice(0, 3));

            for (const line of rawResults) {
                if (line.trim()) {
                    try {
                        const metadata = JSON.parse(line);
                        console.log(`Processing result: ${metadata.title} by ${metadata.uploader} (extractor: ${metadata.extractor_key})`);
                        
                        // Filter for SoundCloud results
                        if (metadata.extractor_key && metadata.extractor_key.includes('Soundcloud')) {
                            formattedResults.push({
                                title: metadata.title,
                                artist: metadata.uploader || metadata.channel || 'Unknown',
                                url: metadata.webpage_url,
                                // Prefer the last (highest resolution) thumbnail if available
                                thumbnail: metadata.thumbnails ? metadata.thumbnails[metadata.thumbnails.length - 1]?.url : null
                            });
                        } else {
                            console.log(`Skipping non-SoundCloud result: ${metadata.extractor_key}`);
                        }
                    } catch (parseLineError) {
                        console.warn(`Failed to parse a line of search result JSON: ${parseLineError.message} - Line: "${line.substring(0, 100)}..."`);
                    }
                }
            }

            console.log(`Successfully found ${formattedResults.length} SoundCloud results for: "${query}"`);
            
            // If we only got 1 result, try a different search approach
            if (formattedResults.length <= 1) {
                console.log(`Only ${formattedResults.length} result found, trying alternative search method...`);
                
                // Try a different search approach using direct SoundCloud search URL
                const fallbackCommand = `yt-dlp --dump-json --flat-playlist --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36" --no-check-certificate --socket-timeout 60 "https://soundcloud.com/search/sounds?q=${encodeURIComponent(query)}"`;
                
                exec(fallbackCommand, { maxBuffer: 1024 * 1024 * 50 }, (fallbackError, fallbackStdout, fallbackStderr) => {
                    if (!fallbackError && fallbackStdout.trim()) {
                        const fallbackRawResults = fallbackStdout.trim().split('\n');
                        const fallbackFormattedResults = [];
                        
                        console.log(`Fallback search returned ${fallbackRawResults.length} lines`);
                        
                        for (const line of fallbackRawResults) {
                            if (line.trim()) {
                                try {
                                    const metadata = JSON.parse(line);
                                    if (metadata.extractor_key && metadata.extractor_key.includes('Soundcloud')) {
                                        fallbackFormattedResults.push({
                                            title: metadata.title,
                                            artist: metadata.uploader || metadata.channel || 'Unknown',
                                            url: metadata.webpage_url,
                                            thumbnail: metadata.thumbnails ? metadata.thumbnails[metadata.thumbnails.length - 1]?.url : null
                                        });
                                    }
                                } catch (parseLineError) {
                                    console.warn(`Failed to parse fallback result: ${parseLineError.message}`);
                                }
                            }
                        }
                        
                        console.log(`Fallback search found ${fallbackFormattedResults.length} results`);
                        
                        // Use fallback results if they're better
                        if (fallbackFormattedResults.length > formattedResults.length) {
                            return res.json({ success: true, results: fallbackFormattedResults });
                        }
                    }
                    
                    // Return original results if fallback didn't help
                    if (formattedResults.length === 0 && rawResults.length > 0) {
                        return res.status(200).json({ success: false, message: 'No relevant SoundCloud songs found. Try a more specific query.', results: [] });
                    }
                    res.json({ success: true, results: formattedResults });
                });
                return; // Exit here to avoid double response
            }
            
            if (formattedResults.length === 0 && rawResults.length > 0) {
                // This means yt-dlp found something, but we filtered it out (e.g., non-SoundCloud)
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
 */
app.post('/download-mp3', async (req, res) => {
    console.log('Backend: Received POST /download-mp3 request. Raw body:', req.body);
    const { url } = req.body;
    console.log('Backend: Extracted URL from body:', url);

    if (!url) {
        return res.status(400).json({ success: false, message: 'Source URL is required for download.' });
    }

    // Create a unique hash for the URL to use as a filename, preventing duplicates
    const hash = crypto.createHash('md5').update(url).digest('hex');
    const outputFileName = `${hash}.mp3`;
    const outputFilePath = path.join(audioDir, outputFileName);
    // Construct the public URL for the audio file. req.hostname will be Render's domain.
    const publicAudioUrl = `https://${req.hostname}/audio/${outputFileName}`;

    // Check if the file already exists to avoid re-downloading
    if (fs.existsSync(outputFilePath)) {
        console.log(`MP3 for URL hash ${hash} already exists. Serving existing file.`);
        // Even if file exists, try to fetch fresh metadata in case title/artist is needed
        const metadataCommand = `yt-dlp --print-json --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36" --no-check-certificate --socket-timeout 60 "${url}"`;
        exec(metadataCommand, { maxBuffer: 1024 * 1024 * 5 }, (metaError, metaStdout, metaStderr) => {
            if (metaError) {
                console.warn(`Error getting metadata for existing file ${url}: ${metaError.message}. Sending generic metadata.`);
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
                console.error(`Failed to parse metadata JSON for existing file: ${parseMetaError.message}`);
                res.status(500).json({ success: false, message: 'Failed to parse metadata for existing file.' });
            }
        });
        return; // Exit here if file already exists
    }

    console.log(`Starting download and conversion for ${url} to ${outputFilePath}`);
    // Command to extract audio, convert to mp3, and save to outputFilePath
    // -x: extract audio
    // --audio-format mp3: convert extracted audio to mp3
    // -o: output filename template (here, directly the full path)
    // --force-overwrites: ensure file is overwritten if partially exists (e.g., from failed previous attempt)
    const command = `yt-dlp -x --audio-format mp3 -o "${outputFilePath}" --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36" --no-check-certificate --socket-timeout 60 --force-overwrites "${url}"`;

    exec(command, { maxBuffer: 1024 * 1024 * 10 }, async (error, stdout, stderr) => {
        if (error) {
            // Clean up potentially incomplete file
            if (fs.existsSync(outputFilePath)) {
                fs.unlinkSync(outputFilePath);
                console.log(`Cleaned up incomplete file: ${outputFilePath}`);
            }

            console.error(`exec error for download: ${error.message}`);
            console.error(`stdout: ${stdout}`);
            console.error(`stderr: ${stderr}`);
            let errorMessage = `Failed to download or convert: ${error.message}`;

            if (stderr.includes('Sign in to confirm you\'re not a bot') || stderr.includes('Please log in')) {
                errorMessage = 'Download blocked by source website (bot detection/login required).';
            } else if (stderr.includes('No such video') || stderr.includes('Private video') || stderr.includes('unavailable')) {
                errorMessage = 'Track not found, unavailable, or is private.';
            } else if (stderr.includes('Unsupported URL')) {
                errorMessage = 'Unsupported URL for download. Please ensure it is a valid video/audio page.';
            } else if (stderr.includes('timed out')) {
                errorMessage = 'Download timed out. The server might be too slow or network issues.';
            } else if (stderr.includes('no such option')) {
                errorMessage = `An unsupported yt-dlp option was used. Please check backend logs or update yt-dlp.`;
            } else if (stderr.includes('RateLimitExceeded')) {
                errorMessage = 'Source website rate limit exceeded. Please try again later.';
            } else if (stderr.includes('ffprobe') || stderr.includes('ffmpeg')) {
                errorMessage = 'Audio conversion tools (ffmpeg/ffprobe) not found or not working on server. Check server setup.';
            }
            return res.status(500).json({ success: false, message: errorMessage, stderr: stderr });
        }
        if (stderr) {
            console.warn(`stderr for download (non-error output): ${stderr}`);
        }

        console.log(`Download/Conversion successful for ${url}`);

        // After successful download, extract metadata using yt-dlp --print-json to send back to frontend
        const metadataCommand = `yt-dlp --print-json --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36" --no-check-certificate --socket-timeout 60 "${url}"`;
        exec(metadataCommand, { maxBuffer: 1024 * 1024 * 5 }, (metaError, metaStdout, metaStderr) => {
            if (metaError) {
                console.error(`exec error for metadata after download: ${metaError.message}`);
                return res.json({
                    success: true, // Still success as the file is downloaded
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
                console.error(`Failed to parse metadata JSON after download: ${parseMetaError.message}`);
                res.status(500).json({ success: false, message: 'Failed to parse metadata after download.' });
            }
        });
    });
});

// Start the server
app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
    console.log(`Audio files will be stored in: ${audioDir}`);
});

