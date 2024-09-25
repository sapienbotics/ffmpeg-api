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

const convertImageToVideo = (imagePath, outputVideoPath, duration) => {
    return new Promise((resolve, reject) => {
        ffmpeg(imagePath)
            .inputOptions('-f image2')  // Ensure it's treated as an image input
            .loop(duration) // Loop the image for the given duration
            .outputOptions([
                `-t ${duration}`,      // Set the duration
                '-c:v libx264',        // Use H.264 encoding
                '-vf "scale=640:360:force_original_aspect_ratio=increase,crop=640:360"', // Scale dynamically and crop if needed
                '-pix_fmt yuv420p',    // Use the standard pixel format
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
        if (!mediaSequence || mediaSequence.length === 0) {
            return res.status(400).send('Invalid media sequence');
        }

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

        let totalDuration = mediaSequence.reduce((sum, media) => sum + media.duration, 0);
        let validMediaSequence = [];

        await Promise.all(mediaSequence.map(async media => {
            const fileName = path.basename(media.url);
            const filePath = path.join(processedDir, fileName);
            const trimmedFilePath = path.join(processedDir, `trimmed_${fileName}`);

            try {
                if (fileName.endsWith('.mp4') || fileName.endsWith('.mov')) {
                    await new Promise((resolve, reject) => {
                        ffmpeg(filePath)
                            .setStartTime(0)
                            .setDuration(media.duration)
                            .outputOptions('-an')
                            .output(trimmedFilePath)
                            .on('end', () => {
                                console.log(`Processed video: ${trimmedFilePath}`);
                                resolve();
                            })
                            .on('error', reject)
                            .run();
                    });
                    validMediaSequence.push({ url: trimmedFilePath, duration: media.duration });
                } else if (fileName.endsWith('.jpg') || fileName.endsWith('.png')) {
                    await convertImageToVideo(filePath, trimmedFilePath, media.duration);
                    validMediaSequence.push({ url: trimmedFilePath, duration: media.duration });
                }
            } catch (error) {
                console.error(`Error processing media: ${fileName}`, error);
            }
        }));

        if (validMediaSequence.length === 0) {
            return res.status(500).send('All media files failed to process');
        }

        const newDuration = totalDuration / validMediaSequence.length;
        validMediaSequence.forEach(media => {
            media.duration = newDuration;
        });

        const fileListPath = createFileList(validMediaSequence, processedDir);
        const mergedVideoPath = path.join(storageDir, `${uuidv4()}_merged_video.mp4`);
        const ffmpegCommand = `ffmpeg -f concat -safe 0 -i ${fileListPath} -c:v libx264 -an -y ${mergedVideoPath}`;

        exec(ffmpegCommand, (error, stdout, stderr) => {
            if (error) {
                console.error('Error merging media:', error);
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
