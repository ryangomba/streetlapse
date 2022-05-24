const gpxParser = require("gpxparser");
const fs = require("fs");
const https = require("https");
const Stream = require("stream").Transform;
const axios = require("axios");
const { Converter } = require("ffmpeg-stream");


const BASE_URL = "https://maps.googleapis.com/maps/api/streetview";
const PARAMS =
  "?size=1920x1080&location=[LAT],[LON]&fov=80&heading=[HEADING]&pitch=0&source=outdoor&radius=10&key=" + process.env.API_KEY;
const FRAMES_DIR = "_frames";
const INTERPOLATION_ITERATIONS = 1; // Optional (to slow down, 1 is good, 2 is better but slow)
const MAX_POINTS = 2500;

function getImageURL(lat, lon, heading) {
  return `${BASE_URL}${PARAMS}`
    .replace("[LAT]", lat)
    .replace("[LON]", lon)
    .replace("[HEADING]", heading);
}

function getMetadataURL(lat, lon, heading) {
  return `${BASE_URL}/metadata${PARAMS}`
    .replace("[LAT]", lat)
    .replace("[LON]", lon)
    .replace("[HEADING]", heading);
}

var downloadImageFromURL = (url, filename, callback) => {
  console.log("Fetching image...");
  https
    .request(url, function (response) {
      var data = new Stream();
      response.on("data", function (chunk) {
        data.push(chunk);
      });
      response.on("end", function () {
        fs.writeFileSync(filename, data.read());
      });
      response.on("error", (error) => {
        console.error("Error fetching image", error);
      });
    })
    .end();
};

function getBearing(p1, p2) {
  if (!p1) return null;
  if (!p2) return null;
  // β = atan2(X,Y),
  // X = cos θb * sin ∆L
  // Y = cos θa * sin θb – sin θa * cos θb * cos ∆L
  let x = Math.cos(p2.lat) * Math.sin(p2.lon - p1.lon);
  let y =
    Math.cos(p1.lat) * Math.sin(p2.lat) -
    Math.sin(p1.lat) * Math.cos(p2.lat) * Math.cos(p2.lon - p1.lon);
  let b = (Math.atan2(x, y) * 180) / Math.PI;
  if (b < 0) {
    b = 360 + b;
  }
  return b;
}

function average(a, b) {
  if (!a) return b;
  if (!b) return a;
  return (a + b) / 2;
}

function interpolatedPoints(points) {
  let newPoints = [];
  points.forEach((point, i) => {
    newPoints.push(point);
    if (i == points.length - 1) return;
    let { lat: lat1, lon: lon1 } = point;
    let { lat: lat2, lon: lon2 } = points[i + 1];
    newPoints.push({
      lat: average(lat1, lat2),
      lon: average(lon1, lon2),
    });
  });
  return newPoints;
}

async function getPointsFromFile(filename) {
  const data = fs.readFileSync(filename, "utf8");
  let gpx = new gpxParser(); //Create gpxParser Object
  gpx.parse(data); //parse gpx file from string data
  let track = gpx.tracks[0];
  let points = track.points;
  console.log("Points in file:", points.length);
  for (let i = 0; i < INTERPOLATION_ITERATIONS; i++) {
    points = interpolatedPoints(points);
  }
  return points;
}

async function processPointsAndDownloadImages(points) {
  let imageIndex = 1;
  let i = 0;
  let lastPoint = null;
  let lastPanoID = null;
  for (let point of points) {
    let b1 = getBearing(lastPoint, point);
    let b2 = getBearing(point, points[i + 1]);
    let b = average(b1, b2);
    let { lat, lon } = point;
    console.log(i, lat, lon, b);
    let metadataURL = getMetadataURL(lat, lon, b);
    // console.log(metadataURL);

    let data;
    console.log("Fetching metadata...");
    try {
      const response = await axios.get(metadataURL);
      data = response.data;
      // console.log("data", data);
    } catch (error) {
      console.error("Error fetching metadata", error);
    }

    if (data) {
      if (data.status != "OK") {
        console.error("Error with image metadata", data);
      } else {
        let panoID = data.pano_id;
        let isDupe = panoID === lastPanoID;
        lastPanoID = panoID;
        if (isDupe) {
          console.log("SKIP! same pano");
        } else {
          let imageURL = getImageURL(lat, lon, b);
          // console.log(imageURL);
          downloadImageFromURL(imageURL, `${FRAMES_DIR}/${imageIndex}.jpg`);
          imageIndex++;
        }
      }
    }

    lastPoint = point;
    i++;
  }
  console.log(`Processed ${i} frames, downloaded ${imageIndex} images`);
}

async function exportVideo(frames, outputFile) {
  if (fs.existsSync(outputFile)) {
    fs.rmSync(outputFile);
  }

  const converter = new Converter();

  // create input writable stream (the jpeg frames)
  const converterInput = converter.createInputStream({
    f: "image2pipe",
    r: 30,
  });

  // create output to file (mp4 video)
  converter.createOutputToFile(outputFile, {
    "c:v": "libx264",
    pix_fmt: "yuv420p",
    // crf: 2,
    // preset: "veryslow",
  });

  // start the converter, save the promise for later
  const convertingFinished = converter.run();

  // pipe all the frames to the converter sequentially
  for (let filepath of frames) {
    console.log(filepath);
    await new Promise((resolve, reject) => {
      let rs = fs.createReadStream(filepath);
      rs.on("end", resolve); // resolve the promise after the frame finishes
      rs.on("error", reject);
      rs.pipe(converterInput, { end: false }); // pipe to converter, but don't end the input yet
    });
  }
  converterInput.end();

  // await until the whole process finished just in case
  await convertingFinished;
}

async function run() {
  const args = process.argv.slice(2);
  const [inputFile, outputFile] = args;

  let points = await getPointsFromFile(inputFile);
  console.log("Points:", points.length);
  if (points.length > MAX_POINTS) {
    console.warn(`Too many points; trimming to first ${MAX_POINTS}`);
    points = points.slice(0, MAX_POINTS);
    // process.exit(0);
  }

  if (fs.existsSync(FRAMES_DIR)) {
    fs.rmSync(FRAMES_DIR, { recursive: true });
  }
  fs.mkdirSync(FRAMES_DIR);
  await processPointsAndDownloadImages(points);

  const frames = fs
    .readdirSync(FRAMES_DIR)
    .filter((f) => f.endsWith(".jpg"))
    .sort(function (a, b) {
      return a.split(".")[0] - b.split(".")[0];
    })
    .map((filename) => `${FRAMES_DIR}/${filename}`);
  await exportVideo(frames, outputFile);
}

run();
