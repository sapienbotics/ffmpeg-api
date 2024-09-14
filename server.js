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

if (!fs.existsSync(storageDir)) {
    fs.mkdirSync(storageDir, { recursive: true });
}

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

function logFileProperties(filePath) {
    try {
        const output = execSync(`${ffmpegPath} -v error -show_format -show_streams ${filePath}`).toString();
        console.log(`File properties for ${filePath}:\n`, output);
    } catch (error) {
        console.error(`Error logging properties for ${filePath}:`, error.message);
    }
}

function preprocessAudio(inputAudioPath, outputAudioPath, volume) {
    return new Promise((resolve, reject) => {
        const command = `${ffmpegPath} -i ${inputAudioPath} -ar 44100 -ac 2 -filter:a "volume=${volume}" ${outputAudioPath}`;
        exec(command, (error, stdout, stderr) => {
            if (error) {
                console.error('FFmpeg error during audio preprocessing:', error.message);
                console.error('FFmpeg stderr:', stderr);
                reject(error);
            } else {
                console.log('FFmpeg output during audio preprocessing:', stdout);
                resolve();
            }
        });
    });
}

function executeFFmpegCommand(inputVideoPath, inputAudioPath, backgroundAudioPath, outputPath, options) {
    return new Promise((resolve, reject) => {
        const command = `${ffmpegPath} -i ${inputVideoPath} -i ${inputAudioPath} -i ${backgroundAudioPath} ` +
            `-filter_complex "[1:a]volume=${options.inputAudioVolume}[a1]; ` +
            `[2:a]volume=${options.backgroundAudioVolume}[a2]; ` +
            `[a1][a2]amix=inputs=2[a]" ` +
            `-map 0:v -map "[a]" ` +
            `-c:v libx264 -c:a aac -b:a 128k -ac 2 -ar 44100 -shortest ${outputPath}`;

        exec(command, (error, stdout, stderr) => {
            if (error) {
                console.error('FFmpeg error during merging:', error.message);
                console.error('FFmpeg stderr:', stderr);
                reject(error);
            } else {
                console.log('FFmpeg output during merging:', stdout);
                resolve();
            }
        });
    });
}

function trimVideo(inputVideoPath, outputVideoPath, startTime, duration) {
    return new Promise((resolve, reject) => {
        const command = `${ffmpegPath} -i ${inputVideoPath} -ss ${startTime} -t ${duration} -c copy ${outputVideoPath}`;
        exec(command, (error, stdout, stderr) => {
            if (error) {
                console.error('FFmpeg error during trimming:', error.message);
                console.error('FFmpeg stderr:', stderr);
                reject(error);
            } else {
                console.log('FFmpeg output during trimming:', stdout);
                resolve();
            }
        });
    });
}

function getVideoDimensions(videoPath) {
    return new Promise((resolve, reject) => {
        exec(`ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 ${videoPath}`, (error, stdout) => {
            if (error) {
                return reject(error);
            }
            const dimensions = stdout.trim().split('x');
            if (dimensions.length === 2) {
                resolve({ width: parseInt(dimensions[0], 10), height: parseInt(dimensions[1], 10) });
            } else {
                reject(new Error('Failed to get video dimensions'));
            }
        });
    });
}

app.post('/merge-videos', async (req, res) => {
    try {
        console.log('Request received:', req.body);
        const videoUrls = req.body.videos;  // Assume this is an array of URLs
        const tempVideoPaths = await Promise.all(videoUrls.map(url => downloadFile(url, path.join(storageDir, `${uuidv4()}_temp_video.mp4`))));
        const videoDetails = await Promise.all(tempVideoPaths.map(getVideoDimensions));

        const outputFilePath = path.join(storageDir, `${uuidv4()}_merged_video.mp4`);
        // Assuming all videos are same dimensions and can be directly merged without re-encoding
        // Your logic to merge videos here using FFmpeg...

        console.log('Cleaning up temporary files...');
        tempVideoPaths.forEach(videoPath => fs.unlinkSync(videoPath));

        res.status(200).json({ message: 'Videos merged successfully', outputUrl: outputFilePath });
    } catch (error) {
        console.error('Error merging videos:', error.message);
        res.status(500).json({ error: error.message });
    }
});

app.post('/edit-video', async (req, res) => {
    try {
        console.log('Request received:', req.body);
        const inputVideoUrl = req.body.inputVideo;
        const inputAudioUrl = req.body.inputAudio;
        const backgroundAudioUrl = req.body.backgroundAudio;
        const volume = req.body.volume || '1';  // Default volume to 1 if not provided
        const uniqueFilename = `${uuidv4()}_processed_video.mp4`;
        const outputFilePath = path.join(storageDir, uniqueFilename);
        const tempVideoPath = path.join(storageDir, `${uuidv4()}_temp_video.mp4`);
        const tempAudioPath = path.join(storageDir, `${uuidv4()}_temp_audio.mp3`);
        const tempBackgroundAudioPath = path.join(storageDir, `${uuidv4()}_temp_background_audio.mp3`);
        const processedAudioPath = path.join(storageDir, `${uuidv4()}_processed_audio.mp4`);

        console.log('Downloading video from:', inputVideoUrl);
        await downloadFile(inputVideoUrl, tempVideoPath);
        console.log('Downloading audio from:', inputAudioUrl);
        await downloadFile(inputAudioUrl, tempAudioPath);
        console.log('Downloading background audio from:', backgroundAudioUrl);
        await downloadFile(backgroundAudioUrl, tempBackgroundAudioPath);

        logFileProperties(tempVideoPath);
        logFileProperties(tempAudioPath);
        logFileProperties(tempBackgroundAudioPath);

        console.log('Preprocessing main audio...');
        await preprocessAudio(tempAudioPath, processedAudioPath, volume);

        console.log('Processing video with audio...');
        const options = {
            inputAudioVolume: req.body.inputAudioVolume || 1,
            backgroundAudioVolume: req.body.backgroundAudioVolume || 1
        };
        await executeFFmpegCommand(tempVideoPath, processedAudioPath, tempBackgroundAudioPath, outputFilePath, options);

        console.log('Cleaning up temporary files...');
        fs.unlinkSync(tempVideoPath);
        fs.unlinkSync(tempAudioPath);
        fs.unlinkSync(tempBackgroundAudioPath);
        fs.unlinkSync(processedAudioPath);

        res.status(200).json({ message: 'Video processed successfully', outputUrl: outputFilePath });
    } catch (error) {
        console.error('Error processing video:', error.message);
        res.status(500).json({ error: error.message });
    }
});

app.post('/merge-videos', async (req, res) => {
    try {
        console.log('Request received:', req.body);
        const videoData = req.body.videos;
        const orientation = req.body.orientation;
        const uniqueFilename = `${uuidv4()}_merged_video.mp4`;
        const outputFilePath = path.join(storageDir, uniqueFilename);

        if (!videoData || !orientation) {
            throw new Error('Missing videos or orientation');
        }

        const tempVideoPaths = await Promise.all(videoData.map(video => downloadFile(video.url, path.join(storageDir, `${uuidv4()}_temp_video.mp4`))));

        const videoInfos = videoData.map((video, index) => ({
            path: tempVideoPaths[index],
            width: video.width,
            height: video.height
        }));

        await resizeAndMergeVideos(videoInfos, outputFilePath, orientation);

        console.log('Cleaning up temporary files...');
        tempVideoPaths.forEach(tempVideoPath => fs.unlinkSync(tempVideoPath));

        res.status(200).json({ message: 'Videos merged successfully', outputUrl: outputFilePath });
    } catch (error) {
        console.error('Error merging videos:', error.message);
        res.status(500).json({ error: error.message });
    }
});

app.post('/trim-video', async (req, res) => {
    try {
        console.log('Request received:', req.body);
        const inputVideoUrl = req.body.videoUrl;
        const startTime = req.body.startTime;
        const duration = req.body.duration;

        if (!inputVideoUrl || !startTime || !duration) {
            throw new Error('Missing inputVideo, startTime, or duration');
        }

        const uniqueFilename = `${uuidv4()}_trimmed_video.mp4`;
        const outputFilePath = path.join(storageDir, uniqueFilename);
        const tempVideoPath = path.join(storageDir, `${uuidv4()}_temp_video.mp4`);

        console.log('Downloading video from:', inputVideoUrl);
        await downloadFile(inputVideoUrl, tempVideoPath);

        console.log('Trimming video...');
        await trimVideo(tempVideoPath, outputFilePath, startTime, duration);

        console.log('Cleaning up temporary video file...');
        fs.unlinkSync(tempVideoPath);

        res.status(200).json({ message: 'Video trimmed successfully', outputUrl: outputFilePath });
    } catch (error) {
        console.error('Error trimming video:', error.message);
        res.status(500).json({ error: error.message });
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