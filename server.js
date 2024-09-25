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
async function convertImageToVideo(imageUrl, duration) {
    const outputDir = path.join(__dirname, 'output');
    const outputFilePath = path.join(outputDir, `${path.basename(imageUrl)}_${Date.now()}.mp4`);

    // Construct ffmpeg command to convert image to video
    const command = `ffmpeg -loop 1 -i ${imageUrl} -c:v libx264 -t ${duration} -pix_fmt yuv420p ${outputFilePath}`;

    return new Promise((resolve, reject) => {
        exec(command, (error, stdout, stderr) => {
            if (error) {
                console.error(`Error processing media: ${stderr}`);
                return reject(error);
            }
            console.log(`Image converted to video: ${outputFilePath}`);
            resolve(outputFilePath);
        });
    });
}


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
            const mergedVideoPath = await mergeVideos(videoPaths);
            console.log(`Merged video created at: ${mergedVideoPath}`);
        } catch (error) {
            console.error(`Error merging videos: ${error.message}`);
        }
    } else {
        console.error('No valid media found for merging.');
    }
}



async function mergeVideos(videoPaths) {
    const outputDir = path.join(__dirname, 'output'); // Ensure this directory exists
    const outputFilePath = path.join(outputDir, `merged_${Date.now()}.mp4`); // Unique filename for merged video

    // Create filter_complex string
    const filterComplex = videoPaths.map((v, i) => `[${i}:v]`).join('') + `concat=n=${videoPaths.length}:v=1:a=0`;

    // Construct ffmpeg command
    const command = `ffmpeg ${videoPaths.map(v => `-i ${v}`).join(' ')} -filter_complex "${filterComplex}" -y ${outputFilePath}`;

    return new Promise((resolve, reject) => {
        exec(command, (error, stdout, stderr) => {
            if (error) {
                console.error(`Error merging videos: ${stderr}`);
                return reject(error);
            }
            resolve(outputFilePath);
        });
    });
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
    const outputDir = path.join(__dirname, 'output'); // Ensure this directory exists
    // Check if the output directory exists, if not create it
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }
    const outputPath = path.join(outputDir, `${baseName}_${Date.now()}.mp4`); // Unique filename
    return outputPath;
}


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
            const { url, duration } = media;

            // Check if url and duration are defined and log them
            if (!url || !duration) {
                console.error(`Invalid media entry: ${JSON.stringify(media)}. Skipping this entry.`);
                continue;
            }

            const type = path.extname(url).toLowerCase() === '.mp4' ? 'video' : 'image';
            console.log(`Processing media - Type: ${type}, URL: ${url}, Duration: ${duration}`);

            try {
                let outputVideoPath;

                // If the media is an image, convert it to a video
                if (type === 'image') {
                    outputVideoPath = generateOutputPath(url); // Generate output path for image-to-video conversion
                    console.log(`Converting image to video: ${url}`);
                    await convertImageToVideo(url, outputVideoPath, duration); // Convert image to video
                    validMediaSequence.push(outputVideoPath); // Add valid output to sequence
                    console.log(`Image converted to video: ${outputVideoPath}`);
                } 
                // If the media is a video, add it directly
                else if (type === 'video') {
                    console.log(`Processing video: ${url}`);
                    outputVideoPath = url; // Use the video URL directly
                    validMediaSequence.push(outputVideoPath); // Add valid video to sequence
                }
            } catch (error) {
                console.error(`Error processing media: ${url}`, error);
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
