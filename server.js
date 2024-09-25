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

async function trimVideo(inputFilePath, duration) {
    const outputFilePath = path.join(outputDir, `${path.basename(inputFilePath, path.extname(inputFilePath))}_trimmed.mp4`);

    return new Promise((resolve, reject) => {
        ffmpeg(inputFilePath)
            .ffprobe((err, data) => {
                if (err) {
                    console.error(`Error getting video info: ${err.message}`);
                    return reject(err);
                }

                const videoDuration = data.format.duration;

                // Ensure we don't try to trim to a duration longer than the video
                const trimDuration = Math.min(duration, videoDuration);

                ffmpeg(inputFilePath)
                    .outputOptions([
                        '-t', trimDuration,  // Set duration
                        '-vf', 'fps=25',  // Set frame rate to 25 fps for consistency
                        '-c:v', 'libx264',  // Encode with libx264
                        '-preset', 'fast',  // Faster encoding
                        '-movflags', 'faststart',  // Optimize for playback
                        '-pix_fmt', 'yuv420p'  // Ensure compatibility
                    ])
                    .on('end', () => {
                        console.log(`Trimmed video created: ${outputFilePath}`);
                        resolve(outputFilePath);
                    })
                    .on('error', (err) => {
                        console.error(`Error trimming video: ${err.message}`);
                        reject(err);
                    })
                    .save(outputFilePath);
            });
    });
}

async function convertImageToVideo(imageUrl, duration) {
    const outputVideoPath = path.join(outputDir, `${Date.now()}_image.mp4`);
    return new Promise((resolve, reject) => {
        ffmpeg(imageUrl)
            .inputOptions('-loop', '1')  // Loop the image to fill the duration
            .outputOptions([
                '-t', duration,  // Set exact duration
                '-pix_fmt', 'yuv420p',  // Ensure video compatibility
                '-r', '30',  // Set frame rate to 30 fps
            ])
            .on('end', () => {
                console.log(`Converted ${imageUrl} to video.`);
                resolve(outputVideoPath);
            })
            .on('error', (err) => {
                console.error(`Error converting image to video: ${err.message}`);
                reject(err);
            })
            .save(outputVideoPath);
    });
}





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


// Combined and optimized Image to Video conversion with error handling for dimensions
async function convertImageToVideo(imageUrl, duration) {
    const outputVideoPath = path.join(outputDir, `${Date.now()}_image.mp4`);
    const localImagePath = path.join(outputDir, path.basename(imageUrl));

    await downloadFile(imageUrl, localImagePath);  // Download the image

    return new Promise((resolve, reject) => {
        ffmpeg(localImagePath)
            .inputOptions('-loop', '1')  // Loop the image to fill the duration
            .outputOptions([
                '-t', duration,  // Set duration
                '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease',  // Scale to 1280x720, maintain aspect ratio
                '-pix_fmt', 'yuv420p',  // Ensure video compatibility
                '-r', '25',  // Set frame rate to 25fps
            ])
            .on('end', () => {
                console.log(`Converted ${imageUrl} to video.`);
                resolve(outputVideoPath);
            })
            .on('error', (err) => {
                console.error(`Error converting image to video: ${err.message}`);
                reject(err);
            })
            .save(outputVideoPath);
    });
}


const mergeMediaUsingFile = async (mediaArray, totalDuration) => {
    const validMedia = mediaArray.filter(media => media && media.endsWith('.mp4'));

    if (validMedia.length === 0) {
        throw new Error('No valid media to merge.');
    }

    const concatFilePath = path.join(outputDir, `concat_list_${Date.now()}.txt`);
    const concatFileContent = validMedia.map(media => `file '${media}'`).join('\n');
    fs.writeFileSync(concatFilePath, concatFileContent);

    const outputFilePath = path.join(outputDir, `merged_output_${Date.now()}.mp4`);

    return new Promise((resolve, reject) => {
        ffmpeg()
            .input(concatFilePath)
            .inputOptions(['-f', 'concat', '-safe', '0'])
            .outputOptions(['-c', 'copy', '-movflags', 'faststart'])  // Faststart for smooth playback
            .on('end', () => {
                console.log('Merging finished.');
                resolve({
                    status: 'success',
                    outputFileUrl: `https://ffmpeg-api-production.up.railway.app/download/merged/${path.basename(outputFilePath)}`,
                    duration: totalDuration
                });
            })
            .on('error', (err) => {
                console.error(`Error merging media: ${err.message}`);
                reject(err);
            })
            .save(outputFilePath);
    });
};




// Function to process media sequence
async function processMediaSequence(mediaSequence) {
    const videoPaths = [];
    let totalDuration = 0;

    for (const media of mediaSequence) {
        const { url, duration } = media;
        const fileType = path.extname(url).toLowerCase();

        // Track total expected duration
        totalDuration += duration;

        try {
            if (['.mp4', '.mov', '.avi', '.mkv'].includes(fileType)) {
                console.log(`Processing media - Type: video, URL: ${url}, Duration: ${duration}`);
                const localVideoPath = path.join(outputDir, path.basename(url));
                await downloadFile(url, localVideoPath);

                const trimmedVideoPath = await trimVideo(localVideoPath, duration);  // Trim video
                videoPaths.push(trimmedVideoPath);  // Add trimmed video to paths
            } else if (['.jpg', '.jpeg', '.png'].includes(fileType)) {
                console.log(`Processing media - Type: image, URL: ${url}, Duration: ${duration}`);
                const videoPath = await convertImageToVideo(url, duration);  // Convert image to video
                videoPaths.push(videoPath);  // Add converted video to paths
            } else {
                console.warn(`Unsupported media type: ${fileType}`);
            }
        } catch (error) {
            console.error(`Error processing media ${url}: ${error.message}`);
        }
    }

    if (videoPaths.length > 0) {
        try {
            const mergeResult = await mergeMediaUsingFile(videoPaths, totalDuration);  // Merge videos
            console.log(`Merged video created at: ${mergeResult.outputFileUrl}`);
            return mergeResult.outputFileUrl;
        } catch (error) {
            console.error(`Error merging videos: ${error.message}`);
            throw error;
        }
    } else {
        console.error('No valid media found for merging.');
        throw new Error('No valid media found for merging.');
    }
}











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

app.post('/merge-media-sequence', async (req, res) => {
    const { mediaSequence } = req.body;

    if (!mediaSequence || !Array.isArray(mediaSequence) || mediaSequence.length === 0) {
        return res.status(400).json({ error: 'Invalid or empty media sequence provided.' });
    }

    try {
        const mergedVideoUrl = await processMediaSequence(mediaSequence);
        res.json({
            message: 'Media merged successfully',
            mergedVideoUrl,  // Include the merged video URL in the response
        });
    } catch (error) {
        console.error(`Error in merge-media-sequence endpoint: ${error.message}`);
        res.status(500).json({ error: error.message });
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

// Download endpoint for merged media
app.get('/download/merged/:filename', (req, res) => {
    const fileName = req.params.filename;
    const filePath = path.join(outputDir, fileName);

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
