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
        console.log(`Starting conversion for image: ${imagePath}`);
        
        ffmpeg(imagePath)
            .inputOptions('-loop 1') // Loop the image
            .outputOptions([
                `-t ${duration}`, // Set the duration of the output video
                '-c:v libx264', // Use H.264 encoding
                '-pix_fmt yuv420p', // Ensure compatibility with most players
                '-vf "scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2"', // Resize and pad
                '-r 30' // Set frame rate
            ])
            .on('start', (commandLine) => {
                console.log(`FFmpeg command: ${commandLine}`);
            })
            .on('progress', (progress) => {
                console.log(`Processing: ${progress.percent}% done`);
            })
            .on('end', () => {
                console.log(`Successfully converted image to video: ${outputVideoPath}`);
                resolve();
            })
            .on('error', (err) => {
                console.error(`Error converting image: ${imagePath}`, err);
                reject(err);
            })
            .save(outputVideoPath);
    });
};

// Example usage
convertImageToVideo('path/to/image.jpg', 'path/to/output/video.mp4', 5)
    .then(() => {
        console.log('Image converted to video successfully.');
    })
    .catch((error) => {
        console.error('Failed to convert image to video:', error);
    });

               



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
                            .outputOptions('-an')  // Remove audio
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

// Start the server
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
