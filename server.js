const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { exec, execSync } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const ffmpegPath = require('ffmpeg-static');

const app = express();
app.use(express.json());

const storageDir = process.env.STORAGE_DIR || '/app/storage/processed';
console.log('Storage Directory:', storageDir);

if (!fs.existsSync(storageDir)) {
    fs.mkdirSync(storageDir, { recursive: true });
}

// Utility function to execute shell commands (like FFmpeg)
function execPromise(command) {
    return new Promise((resolve, reject) => {
        exec(command, (error, stdout, stderr) => {
            if (error) {
                console.error('FFmpeg error:', error.message);
                console.error('FFmpeg stderr:', stderr);
                reject(error);
            } else {
                resolve(stdout);
            }
        });
    });
}

// Download a file from a URL
async function downloadFile(url, outputPath) {
    let retries = 3;
    while (retries > 0) {
        try {
            const response = await axios.get(url, { responseType: 'stream' });
            response.data.pipe(fs.createWriteStream(outputPath));
            return new Promise((resolve, reject) => {
                response.data.on('end', () => resolve(outputPath));
                response.data.on('error', reject);
            });
        } catch (error) {
            console.error(`Error downloading file from ${url}:`, error.message);
            retries--;
            if (retries === 0) throw new Error(`Failed to download file from ${url} after retries`);
        }
    }
}

// Get video dimensions using FFmpeg
async function getVideoDimensions(filePath) {
    const { stdout } = await execPromise(`ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 ${filePath}`);
    const dimensions = stdout.trim().split('x');
    if (dimensions.length === 2) {
        return { width: parseInt(dimensions[0], 10), height: parseInt(dimensions[1], 10) };
    } else {
        throw new Error('Failed to get video dimensions');
    }
}

// Process (resize/pad) a video
async function processVideo(inputPath, outputPath, targetWidth, targetHeight) {
    const command = `${ffmpegPath} -i ${inputPath} -vf "scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease,pad=${targetWidth}:${targetHeight}:(ow-iw)/2:(oh-ih)/2" -c:a copy ${outputPath}`;
    console.log('Executing FFmpeg command:', command);
    const { stdout, stderr } = await execPromise(command);
    console.log('FFmpeg output during video processing:', stdout);
    console.error('FFmpeg stderr during video processing:', stderr);
}

// Merge multiple videos
async function mergeVideos(inputPaths, outputPath) {
    try {
        const listFilePath = path.join(storageDir, `${uuidv4()}_file_list.txt`);
        const fileListContent = inputPaths.map(p => `file '${p}'`).join('\n');
        fs.writeFileSync(listFilePath, fileListContent);

        const command = `${ffmpegPath} -f concat -safe 0 -i ${listFilePath} -c copy ${outputPath}`;
        console.log('Executing FFmpeg command:', command);

        await execPromise(command);

        fs.unlinkSync(listFilePath);
    } catch (error) {
        throw new Error('Error merging videos: ' + error.message);
    }
}

app.post('/merge-videos', async (req, res) => {
    const videoUrls = req.body.videos;
    let tempVideoPaths = [];
    let processedVideoPaths = [];

    try {
        console.log('Request received:', req.body);

        if (!Array.isArray(videoUrls) || videoUrls.some(url => typeof url !== 'string' || !url.trim().startsWith('http'))) {
            throw new Error('Invalid video URLs provided');
        }
        console.log('Video URLs:', videoUrls);

        tempVideoPaths = await Promise.all(videoUrls.map(async (url) => {
            const tempPath = path.join(storageDir, `${uuidv4()}_temp_video.mp4`);
            console.log('Downloading file from URL:', url);
            await downloadFile(url, tempPath);
            return tempPath;
        }));

        const videoDetails = await Promise.all(tempVideoPaths.map(getVideoDimensions));
        console.log('Video details:', videoDetails);

        const { width, height } = videoDetails[0];
        videoDetails.forEach(detail => {
            if (detail.width !== width || detail.height !== height) {
                throw new Error('All videos must have the same dimensions for merging');
            }
        });

        processedVideoPaths = await Promise.all(tempVideoPaths.map(async (tempPath, index) => {
            const processedPath = path.join(storageDir, `${uuidv4()}_processed_video.mp4`);
            console.log(`Processing video ${index + 1}:`, tempPath);
            await processVideo(tempPath, processedPath, width, height);
            return processedPath;
        }));

        console.log('Processed video paths:', processedVideoPaths);

        const outputFilePath = path.join(storageDir, `${uuidv4()}_merged_video.mp4`);
        await mergeVideos(processedVideoPaths, outputFilePath);

        tempVideoPaths.forEach(fs.unlinkSync);
        processedVideoPaths.forEach(fs.unlinkSync);

        res.status(200).json({ message: 'Videos merged successfully', outputUrl: `/video/${path.basename(outputFilePath)}` });

    } catch (error) {
        console.error('Error merging videos:', error.message);
        res.status(500).json({ error: error.message });
    } finally {
        tempVideoPaths.forEach(filePath => fs.existsSync(filePath) && fs.unlinkSync(filePath));
        processedVideoPaths.forEach(filePath => fs.existsSync(filePath) && fs.unlinkSync(filePath));
    }
});

app.get('/video/:filename', (req, res) => {
    const filePath = path.join(storageDir, req.params.filename);
    if (fs.existsSync(filePath)) {
        res.setHeader('Content-Disposition', 'attachment; filename="' + req.params.filename + '"');
        res.sendFile(filePath);
    } else {
        res.status(404).send('File not found');
    }
});

const port = process.env.PORT || 8080;
app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});
