const express = require('express');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const app = express();
app.use(express.json());

const storageDir = path.join(__dirname, 'storage');

// Helper function to probe video duration using FFMPEG
function probeVideoDuration(filePath) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(filePath, (err, metadata) => {
            if (err) return reject(err);
            const duration = metadata.format.duration;
            resolve(duration);
        });
    });
}

// Helper function to probe audio duration using FFMPEG
function probeAudioDuration(filePath) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(filePath, (err, metadata) => {
            if (err) return reject(err);
            if (!metadata.streams || metadata.streams.length === 0) {
                return reject(new Error('No audio streams found'));
            }
            const audioStream = metadata.streams.find(stream => stream.codec_type === 'audio');
            if (audioStream) {
                const duration = metadata.format.duration;
                resolve(duration);
            } else {
                reject(new Error('No audio stream in the file'));
            }
        });
    });
}

// Function to convert an image to a video of a given duration
async function convertImageToVideo(imageUrl, duration) {
    const outputPath = path.join(storageDir, `${uuidv4()}_converted_video.mp4`);

    return new Promise((resolve, reject) => {
        ffmpeg(imageUrl)
            .inputFormat('image2') // Specify input format
            .duration(duration) // Set duration
            .fps(30) // Set frames per second
            .save(outputPath)
            .on('end', () => {
                console.log(`Converted video path: ${outputPath}`);
                resolve(outputPath);
            })
            .on('error', (err) => {
                console.error(`Error converting image to video: ${err.message}`);
                reject(err);
            });
    });
}

// Helper function to check media duration
async function probeMediaDuration(filePath) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(filePath, (err, metadata) => {
            if (err) {
                console.error(`Error probing media ${filePath}: ${err.message}`);
                resolve('N/A'); // If there's an error probing, return N/A
            } else {
                const duration = metadata.format.duration;
                resolve(duration ? parseFloat(duration) : 'N/A');
            }
        });
    });
}

// Function to create the file list for FFmpeg
async function createFileList(mediaPaths) {
    const fileListPath = path.join(storageDir, 'file_list.txt'); 
    let fileListContent = '';

    for (let mediaPath of mediaPaths) {
        const cleanPath = path.resolve(mediaPath);
        let duration;

        try {
            duration = await probeMediaDuration(cleanPath); // Probe the duration of the media
        } catch (error) {
            console.error(`Error probing media ${cleanPath}: ${error.message}`);
            continue; // Skip this file and continue with others
        }

        if (duration === 'N/A' || duration < 1) { // If no duration, convert to video with default duration
            try {
                mediaPath = await convertImageToVideo(cleanPath, 5); // Convert to a 5-second video
            } catch (error) {
                console.error(`Skipping file ${cleanPath} due to conversion error: ${error.message}`);
                continue; // Skip this file and continue with others
            }
        }

        fileListContent += `file '${cleanPath}'\n`;
    }

    fs.writeFileSync(fileListPath, fileListContent); // Write the final file list
    console.log(`File list created at: ${fileListPath}`);
    return fileListPath;
}

// Function to merge media sequence
async function mergeMediaSequence(mediaFiles, outputFilePath) {
    const inputFiles = mediaFiles.filter(file => file !== null).map(file => file.url || file); // Ensure valid file paths

    if (inputFiles.length === 0) {
        console.error('No valid media files to process.');
        return null;
    }

    try {
        const fileListPath = await createFileList(inputFiles);

        await new Promise((resolve, reject) => {
            ffmpeg()
                .input(fileListPath)
                .inputFormat('concat')
                .outputOptions('-safe', '0') // Allow both relative and absolute paths in the file list
                .outputOptions('-c', 'copy') // Copy codec, no re-encoding
                .save(outputFilePath)
                .on('end', () => {
                    console.log('Merging finished successfully.');
                    resolve();
                })
                .on('error', (err) => {
                    console.error(`Error during merging: ${err.message}`);
                    reject(err);
                });
        });

        return outputFilePath;
    } catch (error) {
        console.error(`Error merging media sequence: ${error.message}`);
        return null;
    }
}

// Download file
const downloadFile = async (url, filepath) => {
  const writer = fs.createWriteStream(filepath);
  const response = await axios({
    url,
    method: 'GET',
    responseType: 'stream',
  });

  response.data.pipe(writer);

  return new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
};

// Endpoint to merge images and videos in sequence
app.post('/merge-media-sequence', async (req, res) => {
    try {
        const { mediaSequence } = req.body;
        if (!mediaSequence || !Array.isArray(mediaSequence)) {
            return res.status(400).json({ error: 'Invalid mediaSequence input. It must be an array of media objects.' });
        }

        const outputFilePath = path.join(storageDir, `${uuidv4()}_merged_sequence.mp4`);
        await mergeMediaSequence(mediaSequence, outputFilePath);

        res.status(200).json({ message: 'Media merged successfully', outputUrl: outputFilePath });
    } catch (error) {
        console.error('Error merging media sequence:', error);
        res.status(500).json({ error: 'Failed to merge media sequence.' });
    }
});


// Endpoint to get audio duration
app.post('/get-audio-duration', async (req, res) => {
  try {
    const { audioUrl } = req.body;

    // Validate audioUrl
    if (!audioUrl) {
      return res.status(400).json({ error: 'Missing audio URL.' });
    }

    // Temporary path to store the audio file
    const tempAudioPath = path.join(storageDir, `${uuidv4()}_audio.mp3`);

    // Download the audio file to a temp path
    await downloadFile(audioUrl, tempAudioPath);

    // Get audio metadata using ffmpeg
    ffmpeg.ffprobe(tempAudioPath, (err, metadata) => {
      if (err) {
        console.error('Error fetching audio metadata:', err);
        return res.status(500).json({ error: 'Error fetching audio metadata.' });
      }

      // Extract duration from metadata
      const duration = metadata.format.duration;

      // Clean up the temporary audio file
      fs.unlinkSync(tempAudioPath);

      // Respond with the audio duration
      res.json({ duration });
    });
  } catch (error) {
    console.error('Error processing get-audio-duration request:', error.message);
    res.status(500).json({ error: 'Failed to retrieve audio duration.' });
  }
});


// Endpoint to download merged files
app.get('/download/:filename', (req, res) => {
    const { filename } = req.params;
    const filePath = path.join(storageDir, filename);

    // Check if file exists
    if (fs.existsSync(filePath)) {
        // Set appropriate headers for file download
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Content-Type', 'application/octet-stream');
        res.sendFile(filePath);
    } else {
        res.status(404).json({ error: 'File not found' });
    }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
