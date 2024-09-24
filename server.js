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
        return `file '${filePath}'`;
    }).join('\n');

    const fileListPath = path.join(outputDir, 'file_list.txt');
    fs.writeFileSync(fileListPath, fileListContent);

    return fileListPath;
};

// Convert image to video with fallback error handling
const convertImageToVideo = (imagePath, outputVideoPath, duration) => {
    return new Promise((resolve, reject) => {
        ffmpeg(imagePath)
            .inputOptions('-f image2') // Treat input as an image
            .loop(duration) // Loop the image for the specified duration
            .outputOptions([
                `-t ${duration}`,        // Set the duration of the output video
                '-c:v libx264',          // Use H.264 encoding
                '-vf "scale=640:360"',   // Force scaling to 640x360 resolution
                '-pix_fmt yuv420p',      // Ensure compatibility with most players
                '-r 30',                 // Set frame rate to 30fps
            ])
            .on('end', () => {
                console.log(`Converted image to video: ${outputVideoPath}`);
                resolve();
            })
            .on('error', (err) => {
                console.error(`Error converting image: ${imagePath}`, err);
                reject(err);
            })
            .save(outputVideoPath);
    });
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

        // Step 2: Process each media file (trim videos, convert images to videos)
        const processedMedia = await Promise.all(mediaSequence.map(async media => {
            const fileName = path.basename(media.url);
            const filePath = path.join(processedDir, fileName);
            const trimmedFilePath = path.join(processedDir, `trimmed_${fileName}`);

            if (fileName.endsWith('.mp4') || fileName.endsWith('.mov')) {
                // Trim videos
                return new Promise((resolve, reject) => {
                    ffmpeg(filePath)
                        .setStartTime(0) // Always start at 0
                        .setDuration(media.duration) // Trim to the specified duration
                        .outputOptions('-an') // Remove audio
                        .output(trimmedFilePath)
                        .on('end', () => {
                            console.log(`Processed video: ${trimmedFilePath}`);
                            resolve(trimmedFilePath);
                        })
                        .on('error', err => {
                            console.error(`Error processing video: ${filePath}`, err);
                            reject(err);
                        })
                        .run();
                });
            } else if (fileName.endsWith('.jpg') || fileName.endsWith('.jpeg') || fileName.endsWith('.png')) {
                // Convert images to videos
                try {
                    await convertImageToVideo(filePath, trimmedFilePath, media.duration);
                    return trimmedFilePath;
                } catch (err) {
                    console.error(`Skipping image due to error: ${fileName}`);
                    return null; // Skip this media if conversion fails
                }
            }

            return null; // In case it's an unsupported file format
        }));

        // Filter out nulls (failed conversions)
        const validMedia = processedMedia.filter(media => media !== null);

        if (validMedia.length === 0) {
            return res.status(500).json({ error: 'No media files processed successfully.' });
        }

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

// Endpoint to get audio duration
app.post('/get-audio-duration', async (req, res) => {
    try {
        const { audioUrl } = req.body;

        // Validate audioUrl
        if (!audioUrl) {
            return res.status(400).json({ error: 'Missing audio URL.' });
        }

        // Generate a temporary path to store the downloaded audio file
        const tempAudioPath = path.join(storageDir, `${uuidv4()}_audio.mp3`);

        // Download the audio file to a temporary path
        await downloadFile(audioUrl, tempAudioPath);

        // Use ffmpeg to extract the metadata of the audio file
        ffmpeg.ffprobe(tempAudioPath, (err, metadata) => {
            // If there's an error fetching metadata, handle it
            if (err) {
                console.error('Error fetching audio metadata:', err);
                return res.status(500).json({ error: 'Error fetching audio metadata.' });
            }

            // Check if metadata contains duration information
            if (!metadata.format || !metadata.format.duration) {
                // Clean up the temporary audio file before returning an error
                fs.unlinkSync(tempAudioPath);
                return res.status(500).json({ error: 'Unable to retrieve audio duration.' });
            }

            // Extract duration from metadata
            const duration = metadata.format.duration;

            // Clean up the temporary audio file after processing
            fs.unlinkSync(tempAudioPath);

            // Respond with the audio duration
            res.json({ duration });
        });
    } catch (error) {
        console.error('Error processing get-audio-duration request:', error.message);
        res.status(500).json({ error: 'Failed to retrieve audio duration.' });
    }
});

// Start the server
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
