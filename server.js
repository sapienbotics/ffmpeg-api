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
const outputDir = path.join(__dirname, 'output'); // Added output directory for storing processed videos

// Ensure processed and output directories exist
if (!fs.existsSync(processedDir)) {
    fs.mkdirSync(processedDir, { recursive: true });
}
if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
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

// Updated convertImageToVideo function with correct duration handling
const convertImageToVideo = async (imageUrl, duration) => {
    return new Promise((resolve, reject) => {
        const outputFilePath = path.join(outputDir, `${Date.now()}_image.mp4`);

        ffmpeg(imageUrl)
            .outputOptions([
                '-vf', 'scale=640:360', // Adjust scaling if necessary
                `-t ${duration}`, // Correctly set the duration
            ])
            .on('end', () => {
                console.log(`Converted ${imageUrl} to video.`);
                resolve(outputFilePath);
            })
            .on('error', (err) => {
                console.error(`Error converting image to video: ${err.message}`);
                reject(err);
            })
            .save(outputFilePath);
    });
};


const mergeMedia = async (mediaArray) => {
    const validMedia = mediaArray.filter(media => media && media.endsWith('.mp4')); // Ensure valid media

    if (validMedia.length === 0) {
        throw new Error('No valid media to merge.');
    }

    return new Promise((resolve, reject) => {
        const outputFilePath = path.join(outputDir, `merged_output_${Date.now()}.mp4`);

        // Create ffmpeg instance
        const ffmpegCmd = ffmpeg();

        validMedia.forEach(media => {
            // Standardize each input by re-encoding, forcing same format and stripping audio
            ffmpegCmd.input(media)
                     .outputOptions([
                         '-vf scale=960:540', // Standard resolution
                         '-c:v libx264',      // Standard video codec
                         '-preset veryfast',  // Fast encoding preset
                         '-crf 23',           // Quality setting
                         '-pix_fmt yuv420p',  // Standard pixel format
                         '-an'                // Remove audio from all inputs
                     ]);
        });

        ffmpegCmd
            .on('end', () => {
                console.log('Merging finished.');
                resolve({
                    status: 'success',
                    outputFileUrl: `https://yourdomain.com/path/to/${path.basename(outputFilePath)}`, // Update with your hosting
                });
            })
            .on('error', (err) => {
                console.error(`Error merging media: ${err.message}`);
                reject(err);
            })
            .mergeToFile(outputFilePath);
    });
};



// Function to process media sequence
async function processMediaSequence(mediaSequence) {
    const videoPaths = [];

    for (const media of mediaSequence) {
        const { url, duration } = media;
        const fileType = path.extname(url).toLowerCase();

        if (['.mp4', '.mov', '.avi', '.mkv'].includes(fileType)) {
            console.log(`Processing media - Type: video, URL: ${url}, Duration: ${duration}`);
            videoPaths.push(url); // Add video URL to paths
        } else if (['.jpg', '.jpeg', '.png'].includes(fileType)) {
            console.log(`Processing media - Type: image, URL: ${url}, Duration: ${duration}`);
            try {
                const videoPath = await convertImageToVideo(url, duration);
                videoPaths.push(videoPath); // Add the converted video path to paths
            } catch (error) {
                console.error(`Error converting image to video: ${error.message}`);
                continue; // Skip to next media item
            }
        }
    }

    if (videoPaths.length > 0) {
        try {
            const mergedVideoPath = await mergeMedia(videoPaths);
            console.log(`Merged video created at: ${mergedVideoPath}`);
        } catch (error) {
            console.error(`Error merging videos: ${error.message}`);
        }
    } else {
        console.error('No valid media found for merging.');
    }
}

// Helper function to clean up temporary files
const cleanupTempFiles = (filePaths) => {
    filePaths.forEach(filePath => {
        fs.unlink(filePath, (err) => {
            if (err) console.error(`Error deleting file: ${filePath}`, err);
            else console.log(`Deleted temporary file: ${filePath}`);
        });
    });
};

// Function to determine media type based on URL extension
const getMediaType = (url) => {
    const extension = path.extname(url).toLowerCase();
    if (['.jpg', '.jpeg', '.png'].includes(extension)) {
        return 'image';
    } else if (['.mp4'].includes(extension)) {
        return 'video';
    }
    return null; // Unknown type
};

// Helper function to generate a unique output path for image-to-video conversion
function generateOutputPath(url) {
    const baseName = path.basename(url, path.extname(url));
    const outputPath = path.join(outputDir, `${baseName}_${Date.now()}.mp4`); // Unique filename
    return outputPath;
}

// Updated media processing logic in the /merge-media-sequence endpoint
app.post('/merge-media-sequence', async (req, res) => {
    try {
        const mediaSequence = req.body.mediaSequence;

        if (!Array.isArray(mediaSequence)) {
            console.error('Invalid media sequence. Expected an array.');
            return res.status(400).json({ error: 'Invalid media sequence format. It should be an array.' });
        }

        let validMediaSequence = [];

        for (const media of mediaSequence) {
            const { url, duration } = media;

            if (!url || !duration) {
                console.error(`Invalid media entry: ${JSON.stringify(media)}. Skipping this entry.`);
                continue;
            }

            const fileType = path.extname(url).toLowerCase();
            if (fileType === '.mp4') {
                validMediaSequence.push(url);
            } else if (['.jpg', '.jpeg', '.png'].includes(fileType)) {
                console.log(`Processing image: ${url}`);
                try {
                    const videoPath = await convertImageToVideo(url, duration);
                    validMediaSequence.push(videoPath);
                } catch (error) {
                    console.error(`Error converting image to video: ${error.message}`);
                    continue;
                }
            } else {
                console.log(`Skipping unsupported media type: ${fileType}`);
            }
        }

        if (validMediaSequence.length > 0) {
            console.log('Merging media:', validMediaSequence);
            const result = await mergeMedia(validMediaSequence);
            res.status(200).json({ message: 'Media merged successfully', link: result.outputFileUrl });
        } else {
            res.status(400).json({ error: 'No valid media to merge' });
        }
    } catch (error) {
        console.error('Error in merge-media-sequence endpoint:', error);
        res.status(500).json({ error: 'An error occurred during media merging' });
    }
});

// Endpoint to get audio duration
app.post('/get-audio-duration', async (req, res) => {
  try {
    const { audioUrl } = req.body;

    if (!audioUrl) {
      return res.status(400).json({ error: 'Missing audio URL.' });
    }

    const tempAudioPath = path.join(storageDir, `${uuidv4()}_audio.mp3`);

    await downloadFile(audioUrl, tempAudioPath);

    ffmpeg.ffprobe(tempAudioPath, (err, metadata) => {
      if (err) {
        console.error('Error fetching audio metadata:', err);
        return res.status(500).json({ error: 'Error processing audio file.' });
      }

      const duration = metadata.format.duration;
      res.json({ duration });
    });
  } catch (error) {
    console.error('Error fetching audio duration:', error);
    res.status(500).json({ error: 'Error processing the request.' });
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
