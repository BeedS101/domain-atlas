// Shared fixtures for the texture tests (manual-3d-textures-*.js).
//
// JPEG_QUADS is a 16x16 baseline JPEG (quality 100, no chroma subsampling)
// with four flat quadrants: top-left (220,40,40), top-right (40,190,60),
// bottom-left (50,80,230), bottom-right (240,210,40). It is embedded rather
// than generated because Node has no JPEG encoder.

const path = require('path');
const { buildGlb, makePng, quadSpec } = require(path.join(__dirname, '..', 'tools', 'lib', 'glb-builder'));

const JPEG_QUADS = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/2wBDAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAARCAAQABADAREAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD876/g8/60D9IK/Lz/AMy8/K+v+8A/0oP7gK/8q8/3AP/Z', 'base64');

const QUADRANTS = { tl: [220, 40, 40, 255], tr: [40, 190, 60, 255], bl: [50, 80, 230, 255], br: [240, 210, 40, 255] };
const quadrantPng = () => makePng(16, 16, (x, y) => QUADRANTS[(y < 8 ? 't' : 'b') + (x < 8 ? 'l' : 'r')]);

// A flat quad with the given texture/material options (see glb-builder buildGlb).
const quadGlb = (extra) => buildGlb({ ...quadSpec(), ...extra });

module.exports = { JPEG_QUADS, QUADRANTS, quadrantPng, quadGlb, buildGlb, makePng, quadSpec };
