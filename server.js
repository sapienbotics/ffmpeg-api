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
        const filePath = path.join(outputDir, `trimmed_${path.basename(media.url)}`);
        return `file '${filePath}'`;
    }).join('\n');

    const fileListPath = path.join(outputDir, 'file_list.txt');
    fs.writeFileSync(fileListPath, fileListContent);

    return fileListPath;
};

// Function to convert image to video
const convertImageToVideo = (imagePath, outputVideoPath, duration) => {
    return new Promise((resolve, reject) => {
        const ffmpegCommand = `ffmpeg -loop 1 -i ${imagePath} -y -t ${duration} -c:v libx264 -pix_fmt yuv420p -r 30 ${outputVideoPath}`;
        
        exec(ffmpegCommand, (error, stdout, stderr) => {
            if (error) {
                console.error(`Error converting image ${imagePath}:`, stderr);
                return reject(new Error('Conversion failed!'));
            }
            resolve();
        });
    });
};

// Function to merge videos
const mergeVideos = (videoPaths) => {
    return new Promise((resolve, reject) => {
        // Create a file list for ffmpeg
        const fileListPath = '/usr/src/app/storage/processed/media/file_list.txt';
        const fileListContent = videoPaths.map(path => `file '${path}'`).join('\n');

        // Write file list to a temporary file
        fs.writeFileSync(fileListPath, fileListContent);

        const ffmpegCommand = `ffmpeg -f concat -safe 0 -i ${fileListPath} -c:v libx264 -an -y /usr/src/app/storage/processed/merged_video.mp4`;

        exec(ffmpegCommand, (error, stdout, stderr) => {
            if (error) {
                console.error('Error merging videos:', stderr);
                return reject(new Error('Merging failed!'));
            }
            resolve();
        });
    });
};

// Endpoint to merge media sequences
app.post('/merge-media-sequence', async (req, res) => {
    try {
        const mediaSequence = req.body.mediaSequence;

        // Log the received mediaSequence for debugging
        console.log("Received media sequence: ", mediaSequence);

        // Ensure mediaSequence is an array
        if (!Array.isArray(mediaSequence)) {
            console.error('Invalid media sequence. Expected an array.');
            return res.status(400).json({ error: 'Invalid media sequence format. It should be an array.' });
        }

        // Initialize validMediaSequence as an empty array
        let validMediaSequence = [];

        // Loop through the media sequence and process each item
        for (const media of mediaSequence) {
            const { type, path, duration } = media;

            // Check if type, path, and duration are defined and log them
            if (!type || !path || !duration) {
                console.error(`Invalid media entry: ${JSON.stringify(media)}. Skipping this entry.`);
                continue;
            }

            console.log(`Processing media - Type: ${type}, Path: ${path}, Duration: ${duration}`);

            try {
                let outputVideoPath;

                // If the media is an image, convert it to a video
                if (type === 'image') {
                    outputVideoPath = generateOutputPath(path); // Generate output path for image-to-video conversion
                    console.log(`Converting image to video: ${path}`);
                    await convertImageToVideo(path, outputVideoPath, duration); // Convert image to video
                    validMediaSequence.push(outputVideoPath); // Add valid output to sequence
                    console.log(`Image converted to video: ${outputVideoPath}`);
                } 
                // If the media is a video, add it directly
                else if (type === 'video') {
                    console.log(`Processing video: ${path}`);
                    outputVideoPath = path; // Use the video path directly
                    validMediaSequence.push(outputVideoPath); // Add valid video to sequence
                }
            } catch (error) {
                console.error(`Error processing media: ${path}`, error);
                continue; // Continue processing even if one media fails
            }
        }

        // Log the validMediaSequence
        console.log('Valid media sequence:', validMediaSequence);

        // Only proceed if there are valid media files
        if (validMediaSequence.length > 0) {
            console.log('Merging media:', validMediaSequence);
            await mergeVideos(validMediaSequence); // Merge the valid media files
            res.status(200).json({ message: 'Media merged successfully' });
        } else {
            console.error('No valid media files to merge.');
            res.status(400).json({ error: 'No valid media files to merge' });
        }
    } catch (error) {
        console.error('Error in merge-media-sequence endpoint:', error);
        res.status(500).json({ error: 'An error occurred during media merging' });
    }
});

// Download endpoint for processed media
app.get('/download/:filename', (req, res) => {
    const fileName = req.params.filename;
    const filePath = path.join(processedDir, fileName);

    if (fs.existsSync(filePath)) {
        res.download(filePath, (err) => {
            if (err) {
                console.error(`Error downloading file: ${fileName}`, err);
                res.status(500).send('Error downloading file');
            }
        });
    } else {
        res.status(404).send('File not found');
    }
});

// Start the server
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
