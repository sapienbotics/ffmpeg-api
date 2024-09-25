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

async function trimVideo(inputPath, duration) {
    const outputVideoPath = path.join(outputDir, `${path.basename(inputPath, path.extname(inputPath))}_trimmed.mp4`);

    return new Promise((resolve, reject) => {
        ffmpeg(inputPath)
            .outputOptions([
                `-t ${duration}`,  // Set the duration explicitly
                '-c:v copy',       // Copy the video codec for efficiency
                '-c:a copy'        // Copy audio codec
            ])
            .on('end', () => {
                console.log(`Trimmed video created: ${outputVideoPath}`);
                resolve(outputVideoPath);
            })
            .on('error', (err) => {
                console.error(`Error trimming video: ${err.message}`);
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


// Optimize Image to Video conversion with error handling for dimensions
async function convertImageToVideo(imageUrl, duration) {
    const outputVideoPath = path.join(outputDir, `${Date.now()}_image.mp4`);
    const localImagePath = path.join(outputDir, path.basename(imageUrl));

    await downloadFile(imageUrl, localImagePath); // Download the image

    return new Promise((resolve, reject) => {
        ffmpeg(localImagePath)
            .inputOptions('-loop', '1')  // Loop the image to fill the duration
            .outputOptions([
                '-t', duration,  // Set duration
                '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease', // Scale to 1280x720, maintain aspect ratio
                '-pix_fmt', 'yuv420p',  // Ensure video compatibility
                '-r', '30',  // Set frame rate to 30fps
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





const mergeMediaUsingFile = async (mediaArray) => {
    const validMedia = mediaArray.filter(media => media && media.endsWith('.mp4'));

    if (validMedia.length === 0) {
        throw new Error('No valid media to merge.');
    }

    // Create a concat file
    const concatFilePath = path.join(outputDir, `concat_list_${Date.now()}.txt`);
    const concatFileContent = validMedia.map(media => `file '${media}'`).join('\n');
    fs.writeFileSync(concatFilePath, concatFileContent);

    console.log(`Contents of concat file: ${concatFileContent}`);

    const outputFilePath = path.join(outputDir, `merged_output_${Date.now()}.mp4`);

    return new Promise((resolve, reject) => {
        ffmpeg()
            .input(concatFilePath)
            .inputOptions(['-f', 'concat', '-safe', '0'])
            .outputOptions([
                '-c', 'copy',
                '-y' // Overwrite output file if exists
            ])
            .on('end', () => {
                console.log('Merging finished.');
                resolve({
                    status: 'success',
                    outputFileUrl: `https://ffmpeg-api-production.up.railway.app/download/merged/${path.basename(outputFilePath)}`,
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

    for (const media of mediaSequence) {
        const { url, duration } = media;
        const fileType = path.extname(url).toLowerCase();
        const startTime = Date.now();

        if (['.mp4', '.mov', '.avi', '.mkv'].includes(fileType)) {
            console.log(`Processing media - Type: video, URL: ${url}, Duration: ${duration}`);
            try {
                const trimmedVideo = await trimVideo(url, duration);
                videoPaths.push(trimmedVideo);
            } catch (error) {
                console.error(`Error trimming video: ${error.message}`);
                continue;
            }
        } else if (['.jpg', '.jpeg', '.png'].includes(fileType)) {
            console.log(`Processing media - Type: image, URL: ${url}, Duration: ${duration}`);
            try {
                const videoPath = await convertImageToVideo(url, duration);
                videoPaths.push(videoPath);
            } catch (error) {
                console.error(`Error converting image to video: ${error.message}`);
                continue;
            }
        }

        console.log(`Processed ${url} in ${(Date.now() - startTime) / 1000} seconds`);
    }

    if (videoPaths.length > 0) {
        try {
            const mergeResult = await mergeMediaUsingFile(videoPaths);
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
