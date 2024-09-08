const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const app = express();
const port = 8080;

// Use a cross-platform way to define the temp folder
const tempFolder = process.platform === 'win32' ? 'F:\\temp' : '/tmp';

app.use(bodyParser.json());

app.post('/edit-video', async (req, res) => {
    try {
        const { inputVideo, inputAudio, outputFile, options } = req.body;

        if (!inputVideo || !outputFile) {
            return res.status(400).send({ error: 'inputVideo and outputFile are required' });
        }

        // Define file paths for temp video, audio, and output
        const videoPath = path.join(tempFolder, 'temp_input_video.mp4');
        const audioPath = inputAudio ? path.join(tempFolder, 'temp_input_audio.mp3') : null;
        const outputPath = path.join(tempFolder, 'processed_video.mp4');

        // Helper function to delete a file if it exists
        const deleteFileIfExists = (filePath) => {
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
                console.log(`Deleted existing file: ${filePath}`);
            }
        };

        // Delete the existing files before downloading and processing
        deleteFileIfExists(videoPath);
        if (audioPath) deleteFileIfExists(audioPath);
        deleteFileIfExists(outputPath);

        // Download video and audio files
        const downloadFile = (url, filePath) => {
            return new Promise((resolve, reject) => {
                axios({
                    url,
                    method: 'GET',
                    responseType: 'stream'
                }).then(response => {
                    const writer = fs.createWriteStream(filePath);
                    response.data.pipe(writer);
                    writer.on('finish', resolve);
                    writer.on('error', reject);
                }).catch(reject);
            });
        };

        // Download input video and audio if available
        await downloadFile(inputVideo, videoPath);
        if (inputAudio) {
            await downloadFile(inputAudio, audioPath);
        }

        // Construct the FFmpeg command
        const command = inputAudio
            ? `ffmpeg -i ${videoPath} -i ${audioPath} ${options} ${outputPath}`
            : `ffmpeg -i ${videoPath} ${options} ${outputPath}`;

        console.log(`Executing command: ${command}`);

        // Execute the FFmpeg command
        exec(command, (error, stdout, stderr) => {
            if (error) {
                console.error(`Error: ${error.message}`);
                return res.status(500).send({ error: error.message });
            }
            if (stderr) {
                console.error(`Stderr: ${stderr}`);
                return res.status(500).send({ error: stderr });
            }

            // Send success response with the output path or desired details
            res.status(200).send({ 
                message: 'Video processed successfully', 
                outputFile: outputPath, 
                stdout: stdout.trim(),  // Trim to remove extra newlines
                stderr: stderr.trim()   // Trim to remove extra newlines
            });
        });

    } catch (error) {
        res.status(500).send({ error: error.message });
    }
});

app.listen(port, () => {
    console.log(`FFmpeg API listening on port ${port}`);
});
