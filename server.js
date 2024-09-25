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


// Check if valid media before merging
if (validMediaSequence.length > 0) {
    console.log(`Merging the following media:`, validMediaSequence);
    // Proceed with merging...
} else {
    console.error('No valid media files to merge. Please check previous conversion steps.');
}



// Endpoint to merge media sequences
app.post('/merge-media-sequence', async (req, res) => {
    try {
        const mediaSequence = req.body.mediaSequence; // Expecting an array of media paths
        if (!Array.isArray(mediaSequence)) {
            return res.status(400).json({ error: 'Invalid media sequence format. It should be an array.' });
        }

        let validMediaSequence = []; // Initialize validMediaSequence array

        for (const media of mediaSequence) {
            const { type, path, duration } = media; // Assuming media has type, path, and duration properties

            try {
                let outputVideoPath;

                if (type === 'image') {
                    outputVideoPath = generateOutputPath(path); // Generate output path for image-to-video conversion
                    await convertImageToVideo(path, outputVideoPath, duration);
                    validMediaSequence.push(outputVideoPath); // Add valid output to sequence
                } else if (type === 'video') {
                    outputVideoPath = path; // Directly use the video path
                    validMediaSequence.push(outputVideoPath); // Add valid video to sequence
                }
            } catch (error) {
                console.error(`Error processing media: ${path}`, error);
                // Handle specific media conversion errors, but continue processing others
            }
        }

        // Ensure validMediaSequence is defined and not empty before proceeding
        if (validMediaSequence.length > 0) {
            console.log('Merging the following media:', validMediaSequence);
            await mergeVideos(validMediaSequence); // Call to merge valid media files
            res.status(200).json({ message: 'Media merged successfully' });
        } else {
            console.error('No valid media files to merge. Please check the conversion steps.');
            res.status(400).json({ error: 'No valid media files to merge' });
        }
    } catch (error) {
        console.error('Error in merge-media-sequence:', error);
        res.status(500).json({ error: 'An error occurred during merging' });
    }
});


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
