// server.js
const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto'); // For hashing URLs
const NodeCache = require('node-cache'); // Import node-cache

// Firebase Admin SDK Imports
const admin = require('firebase-admin');

// Initialize Firebase Admin SDK
// IMPORTANT: Replace process.env.FIREBASE_ADMIN_SDK_CONFIG with your actual JSON config
// Best practice: Store this JSON content in an environment variable on your hosting platform (e.g., Render)
let firebaseAdminInitialized = false;
try {
    // Check if the environment variable is set
    if (!process.env.FIREBASE_ADMIN_SDK_CONFIG) {
        throw new Error("FIREBASE_ADMIN_SDK_CONFIG environment variable is not set.");
    }
    const serviceAccount = JSON.parse(process.env.FIREBASE_ADMIN_SDK_CONFIG);
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        // !! IMPORTANT !! This has been updated with your provided bucket URL
        storageBucket: "yourmusicplayerapp.appspot.com" 
    });
    console.log("Firebase Admin SDK initialized successfully.");
    firebaseAdminInitialized = true;
} catch (error) {
    console.error("Failed to initialize Firebase Admin SDK:", error.message);
    console.error("Please ensure FIREBASE_ADMIN_SDK_CONFIG environment variable is correctly set with the service account JSON.");
    // Optionally, you might want to stop the server if Firebase initialization is critical
    // process.exit(1); 
}

const app = express();
const PORT = process.env.PORT || 10000;

// Initialize NodeCache for search results with a TTL of 1 hour (3600 seconds)
const searchCache = new NodeCache({ stdTTL: 3600 });

// Middleware
app.use(cors({
    origin: ['https://96mayar96.github.io', 'http://localhost:3000', 'http://localhost:3001'],
    credentials: true
})); // Enable CORS for specific origins
app.use(express.json()); // Parse JSON request bodies

// Directory to store audio files temporarily (before uploading to Firebase Storage)
// Changed to audio_temp as files won't persist here in a cloud environment
const audioDir = path.join(__dirname, 'audio_temp'); 
if (!fs.existsSync(audioDir)) {
    console.log(`Creating temporary audio directory: ${audioDir}`);
    fs.mkdirSync(audioDir);
}

// Serve static audio files from the 'audio_temp' directory.
// This is primarily for temporary local testing or debugging.
// For production with Firebase Storage, frontend will directly access Firebase URLs.
app.use('/audio', express.static(audioDir));

// Root endpoint for a basic status check
app.get('/', (req, res) => {
    res.send('Music Player Backend is running! Temporary audio directory created if needed.');
});

/**
 * /search endpoint
 * Performs a SoundCloud search by name using yt-dlp.
 * Expects a query parameter 'q'.
 * Caches results for better performance.
 */
app.get('/search', async (req, res) => {
    const query = req.query.q;
    if (!query) {
        return res.status(400).json({ success: false, message: 'Search query is required.' });
    }

    const cacheKey = `search_${query}`;
    const cachedResults = searchCache.get(cacheKey);

    if (cachedResults) {
        console.log(`Serving search results for "${query}" from cache.`);
        return res.json({ success: true, results: cachedResults });
    }

    console.log(`Searching SoundCloud for: ${query}`);
    // Use 'scsearch30:' to limit results to SoundCloud and fetch up to 30 results
    const command = `yt-dlp --dump-json --flat-playlist --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36" --no-check-certificate --socket-timeout 60 "scsearch30:${query}"`;
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
            const lines = stdout.split('\n').filter(line => line.trim() !== '');
            const results = lines.map(line => {
                try {
                    const data = JSON.parse(line);
                    return {
                        id: data.id,
                        title: data.title,
                        url: data.url,
                        artist: data.artist || data.uploader || data.channel || 'Unknown',
                        thumbnail: data.thumbnail || `https://placehold.co/60x60/333/FFF?text=🎧`
                    };
                } catch (parseError) {
                    console.warn('Could not parse JSON line from yt-dlp output:', line, parseError);
                    return null;
                }
            }).filter(item => item !== null);

            searchCache.set(cacheKey, results);
            res.json({ success: true, results });

        } catch (parseError) {
            console.error(`Failed to parse yt-dlp search JSON or process results: ${parseError.message}`);
            res.status(500).json({ success: false, message: `Failed to process search results: ${parseError.message}` });
        }
    });
});

/**
 * /download-mp3 endpoint
 * Downloads audio from a given URL, converts it to MP3,
 * uploads it to Firebase Storage, and returns the public URL.
 * Expects a JSON body with a 'url' property.
 */
app.post('/download-mp3', async (req, res) => {
    console.log('Backend: Received POST /download-mp3 request. Raw body:', req.body);
    const { url } = req.body;
    console.log('Backend: Extracted URL from body:', url);

    if (!firebaseAdminInitialized) {
        return res.status(500).json({ success: false, message: 'Firebase Admin SDK is not initialized. Cannot process download and upload to storage.' });
    }
    if (!url) {
        return res.status(400).json({ success: false, message: 'Source URL is required for download.' });
    }

    const bucket = admin.storage().bucket();
    // Use a hash of the original URL as the filename to prevent issues with special characters and ensure uniqueness
    const filenameHash = crypto.createHash('md5').update(url).digest('hex');
    const localOutputFileName = `${filenameHash}.mp3`;
    const localOutputFilePath = path.join(audioDir, localOutputFileName); // Temporary local path
    const firebaseStoragePath = `audio/${localOutputFileName}`; // Path in Firebase Storage

    // 1. Check if the file already exists in Firebase Storage
    let publicAudioUrl = null;
    try {
        const fileRef = bucket.file(firebaseStoragePath);
        const [exists] = await fileRef.exists();
        if (exists) {
            console.log(`File for URL hash ${filenameHash} already exists in Firebase Storage. Serving existing URL.`);
            // Get the public download URL for the existing file
            publicAudioUrl = await fileRef.getSignedUrl({
                action: 'read',
                expires: '03-09-2491', // A very distant future date for effectively permanent public access
            });
            publicAudioUrl = publicAudioUrl[0]; // getSignedUrl returns an array

            // Try to get fresh metadata, if not, use generic
            exec(`yt-dlp --print-json --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36" --no-check-certificate --socket-timeout 60 "${url}"`, { maxBuffer: 1024 * 1024 * 5 }, (metaError, metaStdout) => {
                if (metaError) {
                    console.warn(`Error getting metadata for existing Firebase Storage file ${url}: ${metaError.message}. Sending generic metadata.`);
                    return res.json({
                        success: true,
                        message: 'Audio already processed and available.',
                        audioUrl: publicAudioUrl,
                        title: `Previously Downloaded Track (ID: ${filenameHash.substring(0, 8)})`,
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
                    console.error(`Failed to parse metadata JSON for existing Firebase Storage file: ${parseMetaError.message}`);
                    res.status(500).json({ success: false, message: 'Failed to parse metadata for existing file from Firebase Storage.' });
                }
            });
            return; // Exit if file exists and served from Storage
        }
    } catch (firebaseCheckError) {
        console.error(`Error checking Firebase Storage file existence for ${url}: ${firebaseCheckError.message}`);
        // If checking fails, proceed with download to Firebase Storage.
        // This might happen due to permissions or network issues with Firebase itself.
    }


    console.log(`Starting download and conversion for ${url} to temporary local path: ${localOutputFilePath}`);
    // Command to extract audio, convert to mp3, and save to localOutputFilePath
    const command = `yt-dlp -x --audio-format mp3 -o "${localOutputFilePath}" --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36" --no-check-certificate --socket-timeout 60 --force-overwrites "${url}"`;

    exec(command, { maxBuffer: 1024 * 1024 * 10 }, async (error, stdout, stderr) => {
        if (error) {
            // Clean up potentially incomplete local file
            if (fs.existsSync(localOutputFilePath)) {
                fs.unlinkSync(localOutputFilePath);
                console.log(`Cleaned up incomplete local file: ${localOutputFilePath}`);
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

        console.log(`Download/Conversion successful for ${url} to local temporary storage.`);

        // 2. Upload to Firebase Storage
        try {
            console.log(`Uploading ${localOutputFilePath} to Firebase Storage at ${firebaseStoragePath}`);
            await bucket.upload(localOutputFilePath, {
                destination: firebaseStoragePath,
                metadata: {
                    contentType: 'audio/mpeg', // Set correct content type
                },
                public: true, 
            });
            console.log(`Successfully uploaded to Firebase Storage.`);

            // Get the public download URL.
            publicAudioUrl = await bucket.file(firebaseStoragePath).getSignedUrl({
                action: 'read',
                expires: '03-09-2491', // A very distant future date to ensure the URL is effectively permanent
            });
            publicAudioUrl = publicAudioUrl[0]; // getSignedUrl returns an array

            console.log(`Firebase Storage Public URL: ${publicAudioUrl}`);

            // 3. Clean up local temporary file after successful upload
            if (fs.existsSync(localOutputFilePath)) {
                fs.unlinkSync(localOutputFilePath);
                console.log(`Cleaned up temporary local file: ${localOutputFilePath}`);
            }

        } catch (uploadError) {
            console.error(`Error uploading to Firebase Storage or getting public URL for ${url}: ${uploadError.message}`);
            // Attempt to clean up local file even if Firebase upload fails
            if (fs.existsSync(localOutputFilePath)) {
                fs.unlinkSync(localOutputFilePath);
                console.log(`Cleaned up local file after Firebase upload error: ${localOutputFilePath}`);
            }
            return res.status(500).json({ success: false, message: `Failed to upload audio to cloud storage: ${uploadError.message}` });
        }

        // After successful download and Firebase Storage upload, extract metadata
        exec(`yt-dlp --print-json --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36" --no-check-certificate --socket-timeout 60 "${url}"`, { maxBuffer: 1024 * 1024 * 5 }, (metaError, metaStdout, metaStderr) => {
            if (metaError) {
                console.error(`exec error for metadata after download and upload: ${metaError.message}`);
                return res.json({
                    success: true, // Still success as the file is downloaded and uploaded to storage
                    message: 'Audio downloaded, uploaded, but metadata extraction failed.',
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
                    message: 'Audio downloaded, converted, and uploaded to Firebase Storage!',
                    audioUrl: publicAudioUrl,
                    title: metadata.title,
                    artist: metadata.uploader || metadata.channel || 'Unknown',
                    thumbnail: metadata.thumbnails ? metadata.thumbnails[metadata.thumbnails.length - 1]?.url : null
                });
            } catch (parseMetaError) {
                console.error(`Failed to parse metadata JSON after download and upload: ${parseMetaError.message}`);
                res.status(500).json({ success: false, message: 'Failed to parse metadata after download and upload.' });
            }
        });
    });
});

// Start the server
app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
    console.log(`Temporary audio files will be stored in: ${audioDir}`);
});
