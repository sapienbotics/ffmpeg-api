const express = require('express');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const ffmpeg = require('fluent-ffmpeg');
const app = express();
app.use(express.json());

const storageDir = path.join(__dirname, 'storage', 'processed');
const processedDir = path.join(storageDir, 'media');

// Ensure processed directory exists
if (!fs.existsSync(processedDir)) {
    fs.mkdirSync(processedDir, { recursive: true });
}

// Helper function to download files
const downloadFile = async (url, outputPath) => {
    const response = await axios({
        url,
        method: 'GET',
        responseType: 'stream',
    });

    return new Promise((resolve, reject) => {
        const writer = fs.createWriteStream(outputPath);
        response.data.pipe(writer);
        writer.on('finish', resolve);
        writer.on('error', reject);
    });
};

// Helper function to create file_list.txt for FFmpeg
const createFileList = (mediaSequence, outputDir) => {
    const fileListContent = mediaSequence.map(media => {
        const filePath = path.join(outputDir, path.basename(media.url));
        return `file '${filePath}'\nduration ${media.duration}`;
    }).join('\n');

    const fileListPath = path.join(outputDir, 'file_list.txt');
    fs.writeFileSync(fileListPath, fileListContent);

    return fileListPath;
};

// Merge media sequence endpoint
app.post('/merge-media-sequence', async (req, res) => {
    const { mediaSequence } = req.body;

    try {
        // Ensure media sequence is valid
        if (!mediaSequence || mediaSequence.length === 0) {
            return res.status(400).send('Invalid media sequence');
        }

        // Step 1: Download all media files (both images and videos)
        await Promise.all(mediaSequence.map(async media => {
            const fileName = path.basename(media.url);
            const filePath = path.join(processedDir, fileName);

            if (!fs.existsSync(filePath)) {
                console.log(`Downloading: ${media.url}`);
                await downloadFile(media.url, filePath);
            } else {
                console.log(`File already exists: ${filePath}`);
            }
        }));

        // Step 2: Process each media file
        await Promise.all(mediaSequence.map(async media => {
            const fileName = path.basename(media.url);
            const filePath = path.join(processedDir, fileName);
            const trimmedFilePath = path.join(processedDir, `trimmed_${fileName}`);

            // If it's a video, trim it and remove audio
            if (fileName.endsWith('.mp4') || fileName.endsWith('.mov')) {
                return new Promise((resolve, reject) => {
                    ffmpeg(filePath)
                        .setStartTime(0) // Always start at 0
                        .setDuration(media.duration) // Trim to the specified duration
                        .outputOptions('-an') // Remove audio
                        .output(trimmedFilePath)
                        .on('end', () => {
                            console.log(`Processed video: ${trimmedFilePath}`);
                            resolve();
                        })
                        .on('error', err => {
                            console.error(`Error processing video: ${filePath}`, err);
                            reject(err);
                        })
                        .run();
                });
            }

            // If it's an image, we don't need to process it further
            return Promise.resolve();
        }));

        // Step 3: Create file_list.txt for FFmpeg
        const fileListPath = createFileList(mediaSequence, processedDir);

        // Step 4: Run FFmpeg to merge the media
        const mergedVideoPath = path.join(storageDir, `${uuidv4()}_merged_video.mp4`);
        const ffmpegCommand = `ffmpeg -f concat -safe 0 -i ${fileListPath} -c:v libx264 -an -y ${mergedVideoPath}`;

        exec(ffmpegCommand, (error, stdout, stderr) => {
            if (error) {
                console.error('Error processing merge-media-sequence request:', error);
                return res.status(500).send('Error merging media');
            }

            console.log('Media merged successfully:', mergedVideoPath);
            res.json({ mergedVideoPath });
        });
    } catch (err) {
        console.error('Error processing merge-media-sequence:', err);
        res.status(500).send('Error processing request');
    }
});

// Endpoint to download the merged video
app.get('/download/:fileName', (req, res) => {
    const { fileName } = req.params;
    const filePath = path.join(storageDir, fileName);

    if (fs.existsSync(filePath)) {
        res.download(filePath);
    } else {
        res.status(404).send('File not found');
    }
});

// Start the server
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
