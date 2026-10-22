'use strict';

/**
 * Minimal ZIP writer for "download this photo set" (routes/inventory.js).
 *
 * Stored entries only (no deflate): the payload is JPEGs, which don't
 * compress, so deflate would cost CPU for nothing. Written by hand rather
 * than adding archiver/jszip — the format for stored entries is ~40 lines,
 * and this repo keeps its dependency list short on purpose.
 *
 * Each file is written as soon as it's added, so memory holds one photo at
 * a time, not the whole set. No ZIP64: a set would need to pass 4 GB.
 */

const zlib = require('zlib');

// zlib.crc32 exists from Node 20.15 / 22.2; the table fallback keeps an
// older base image from breaking downloads.
let CRC_TABLE;
function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const d = date || new Date();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const day = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, day };
}

/**
 * @param {import('stream').Writable} out  e.g. an Express res
 */
function createZipWriter(out) {
  const central = [];
  let offset = 0;

  const write = (buf) => {
    out.write(buf);
    offset += buf.length;
  };

  return {
    addFile(name, data, mtime) {
      const nameBuf = Buffer.from(name, 'utf8');
      const crc = crc32(data);
      const { time, day } = dosDateTime(mtime);
      const localOffset = offset;

      const header = Buffer.alloc(30);
      header.writeUInt32LE(0x04034b50, 0);
      header.writeUInt16LE(20, 4); // version needed
      header.writeUInt16LE(0x0800, 6); // UTF-8 names
      header.writeUInt16LE(0, 8); // stored
      header.writeUInt16LE(time, 10);
      header.writeUInt16LE(day, 12);
      header.writeUInt32LE(crc, 14);
      header.writeUInt32LE(data.length, 18);
      header.writeUInt32LE(data.length, 22);
      header.writeUInt16LE(nameBuf.length, 26);
      header.writeUInt16LE(0, 28);
      write(header);
      write(nameBuf);
      write(data);

      const entry = Buffer.alloc(46);
      entry.writeUInt32LE(0x02014b50, 0);
      entry.writeUInt16LE(20, 4); // made by
      entry.writeUInt16LE(20, 6); // needed
      entry.writeUInt16LE(0x0800, 8);
      entry.writeUInt16LE(0, 10);
      entry.writeUInt16LE(time, 12);
      entry.writeUInt16LE(day, 14);
      entry.writeUInt32LE(crc, 16);
      entry.writeUInt32LE(data.length, 20);
      entry.writeUInt32LE(data.length, 24);
      entry.writeUInt16LE(nameBuf.length, 28);
      // extra len, comment len, disk no, internal attrs, external attrs = 0
      entry.writeUInt32LE(localOffset, 42);
      central.push(Buffer.concat([entry, nameBuf]));
    },

    finish() {
      const start = offset;
      for (const c of central) write(c);
      const size = offset - start;
      const end = Buffer.alloc(22);
      end.writeUInt32LE(0x06054b50, 0);
      end.writeUInt16LE(central.length, 8);
      end.writeUInt16LE(central.length, 10);
      end.writeUInt32LE(size, 12);
      end.writeUInt32LE(start, 16);
      out.write(end);
      out.end();
    },
  };
}

module.exports = { createZipWriter, crc32 };
