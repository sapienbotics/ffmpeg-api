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

async function getVideoDimensions(filePath) {
    const { stdout } = await execPromise(`ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 ${filePath}`);
    const dimensions = stdout.trim().split('x');
    if (dimensions.length === 2) {
        return { width: parseInt(dimensions[0], 10), height: parseInt(dimensions[1], 10) };
    } else {
        throw new Error('Failed to get video dimensions');
    }
}

async function processVideo(inputPath, outputPath, targetWidth, targetHeight) {
    const command = `${ffmpegPath} -i ${inputPath} -vf "scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease,pad=${targetWidth}:${targetHeight}:(ow-iw)/2:(oh-ih)/2" -c:a copy ${outputPath}`;
    console.log('Executing FFmpeg command:', command);
    const { stdout, stderr } = await execPromise(command);
    console.log('FFmpeg output during video processing:', stdout);
    console.error('FFmpeg stderr during video processing:', stderr);
}

async function mergeVideos(inputPaths, outputPath) {
    const listFilePath = path.join(storageDir, `${uuidv4()}_file_list.txt`);
    const fileListContent = inputPaths.map(p => `file '${p}'`).join('\n');
    fs.writeFileSync(listFilePath, fileListContent);
    const command = `${ffmpegPath} -f concat -safe 0 -i ${listFilePath} -c copy ${outputPath}`;
    console.log('Executing FFmpeg command for merging:', command);
    const { stdout, stderr } = await execPromise(command);
    console.log('FFmpeg output during merging:', stdout);
    console.error('FFmpeg stderr during merging:', stderr);
    fs.unlinkSync(listFilePath);
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


app.post('/merge-videos', async (req, res) => {
    try {
        console.log('Request received:', req.body);

        const videoUrls = req.body.videos;

        if (!Array.isArray(videoUrls) || videoUrls.some(url => typeof url !== 'string' || !url.startsWith('http'))) {
            throw new Error('Invalid URLs provided');
        }

        console.log('Video URLs:', videoUrls);

        const tempVideoPaths = await Promise.all(videoUrls.map(async (url) => {
            if (!url) throw new Error('URL is undefined');
            const tempPath = path.join(storageDir, `${uuidv4()}_temp_video.mp4`);
            console.log('Downloading file from URL:', url);
            return downloadFile(url, tempPath);
        }));

        const videoDetails = await Promise.all(tempVideoPaths.map(getVideoDimensions));

        console.log('Video details (before processing):', videoDetails);

        const { width, height } = videoDetails[0];
        videoDetails.forEach(detail => {
            if (detail.width !== width || detail.height !== height) {
                throw new Error('All videos must have the same dimensions');
            }
        });

        const processedVideoPaths = await Promise.all(tempVideoPaths.map(async (tempPath, index) => {
            const processedPath = path.join(storageDir, path.basename(tempPath));
            console.log(`Processing video ${index + 1}:`, tempPath);
            await processVideo(tempPath, processedPath, width, height);
            return processedPath;
        }));

        console.log('Processed video paths:', processedVideoPaths);

        const outputFilePath = path.join(storageDir, `${uuidv4()}_merged_video.mp4`);
        await mergeVideos(processedVideoPaths, outputFilePath);

        tempVideoPaths.forEach(videoPath => fs.unlinkSync(videoPath));
        processedVideoPaths.forEach(videoPath => fs.unlinkSync(videoPath));

        res.status(200).json({ message: 'Videos merged successfully', outputUrl: `/video/${path.basename(outputFilePath)}` });
    } catch (error) {
        console.error('Error merging videos:', error.message);
        res.status(500).json({ error: error.message });
    }
});

app.post('/edit-video', async (req, res) => {
    try {
        const inputVideoUrl = req.body.inputVideo;
        const inputAudioUrl = req.body.inputAudio;
        const backgroundAudioUrl = req.body.backgroundAudio;
        const volume = req.body.volume || '1';
        const uniqueFilename = `${uuidv4()}_processed_video.mp4`;
        const outputFilePath = path.join(storageDir, uniqueFilename);

        console.log('Processing video:', inputVideoUrl);
        console.log('Processing audio:', inputAudioUrl);
        console.log('Background audio:', backgroundAudioUrl);

        const tempInputVideoPath = await downloadFile(inputVideoUrl, path.join(storageDir, 'input_video.mp4'));
        const tempInputAudioPath = await downloadFile(inputAudioUrl, path.join(storageDir, 'input_audio.mp3'));
        const tempBackgroundAudioPath = await downloadFile(backgroundAudioUrl, path.join(storageDir, 'background_audio.mp3'));

        console.log('Downloaded files:', tempInputVideoPath, tempInputAudioPath, tempBackgroundAudioPath);

        await preprocessAudio(tempInputAudioPath, path.join(storageDir, 'preprocessed_input_audio.mp3'), volume);
        await executeFFmpegCommand(tempInputVideoPath, path.join(storageDir, 'preprocessed_input_audio.mp3'), tempBackgroundAudioPath, outputFilePath, { inputAudioVolume: 1, backgroundAudioVolume: 0.5 });

        res.json({ message: 'Video edited successfully', outputUrl: `/video/${uniqueFilename}` });
    } catch (error) {
        console.error('Error processing video:', error.message);
        res.status(500).json({ error: error.message });
    }
});

app.post('/trim-video', async (req, res) => {
    try {
        const inputVideoUrl = req.body.videoUrl;
        const startTime = req.body.startTime;
        const duration = req.body.duration;

        const uniqueFilename = `${uuidv4()}_trimmed_video.mp4`;
        const outputFilePath = path.join(storageDir, uniqueFilename);
        const tempVideoPath = path.join(storageDir, `${uuidv4()}_temp_video.mp4`);

        await downloadFile(inputVideoUrl, tempVideoPath);
        await trimVideo(tempVideoPath, outputFilePath, startTime, duration);

        res.status(200).json({ message: 'Video trimmed successfully', outputUrl: `/video/${uniqueFilename}` });
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