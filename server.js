require('dotenv').config(); // Load environment variables from .env file
const express = require('express');
const cors = require('cors');
const ytdl = require('ytdl-core'); // For downloading YouTube videos

const app = express();
const PORT = process.env.PORT || 4000;

// Enable CORS for all origins, or specify your frontend origin later for security
app.use(cors()); // For development, allows all origins
// For production, you might want:
// app.use(cors({ origin: 'https://96Mayar96.github.io/your-music-frontend' }));

app.use(express.json()); // To parse JSON request bodies

// Simple root endpoint for health check
app.get('/', (req, res) => {
    res.send('Backend server is running!');
});

// Endpoint to download YouTube video/audio
app.get('/download', async (req, res) => {
    const videoURL = req.query.url; // Get the YouTube URL from query parameter
    const format = req.query.format || 'mp3'; // Default to mp3, can be 'mp4'

    if (!videoURL || !ytdl.validateURL(videoURL)) {
        return res.status(400).send('Please provide a valid YouTube URL.');
    }

    try {
        const info = await ytdl.getInfo(videoURL);
        let audioFormat;
        let videoTitle = info.videoDetails.title.replace(/[^\w\s-]/g, '').replace(/ /g, '_'); // Sanitize title for filename

        if (format === 'mp3') {
            audioFormat = ytdl.chooseFormat(info.formats, { quality: 'highestaudio', filter: 'audioonly' });
            if (!audioFormat) {
                return res.status(500).send('No suitable audio format found.');
            }
            res.header('Content-Disposition', `attachment; filename="${videoTitle}.mp3"`);
            ytdl(videoURL, { format: audioFormat }).pipe(res);
        } else if (format === 'mp4') {
            // For video (mp4), choose highest quality that is not only audio or only video
            const videoAndAudioFormat = ytdl.chooseFormat(info.formats, { filter: format => format.qualityLabel && format.hasVideo && format.hasAudio });
            if (!videoAndAudioFormat) {
                return res.status(500).send('No suitable video+audio format found.');
            }
            res.header('Content-Disposition', `attachment; filename="${videoTitle}.mp4"`);
            ytdl(videoURL, { format: videoAndAudioFormat }).pipe(res);
        } else {
            return res.status(400).send('Invalid format requested. Choose "mp3" or "mp4".');
        }

    } catch (error) {
        console.error('Error downloading:', error.message);
        res.status(500).send(`Error processing YouTube URL: ${error.message}`);
    }
});

app.listen(PORT, () => {
    console.log(`Backend server listening on port ${PORT}`);
});