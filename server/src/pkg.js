// Builds a macOS installer package (.pkg) without macOS tools, so the server (Docker/Linux) can create a
// per-client package at download time. The result matches what `pkgbuild --nopayload --scripts` produces:
// a xar archive holding PackageInfo + Scripts (gzip'd cpio with a postinstall script that installs the agent).
import crypto from 'node:crypto';
import zlib from 'node:zlib';

const sha1 = (b) => crypto.createHash('sha1').update(b).digest();
const oct = (n, w) => n.toString(8).padStart(w, '0');

/** POSIX "odc" cpio archive (magic 070707), which is what Installer expects inside Scripts/Payload. */
function cpio(entries) {
  const parts = [];
  let ino = 1;
  const mtime = Math.floor(Date.now() / 1000);
  const add = (name, mode, data) => {
    const nameBuf = Buffer.from(name + '\0', 'utf8');
    const header = '070707' + oct(0, 6) + oct(ino++, 6) + oct(mode, 6) + oct(0, 6) + oct(0, 6) + oct(1, 6) + oct(0, 6)
      + oct(mtime, 11) + oct(nameBuf.length, 6) + oct(data.length, 11);
    parts.push(Buffer.from(header, 'ascii'), nameBuf, data);
  };
  add('.', 0o40755, Buffer.alloc(0));
  for (const e of entries) add(e.name, e.mode, e.data);
  add('TRAILER!!!', 0, Buffer.alloc(0));
  return Buffer.concat(parts);
}

/** xar archive: 28-byte header, zlib-compressed XML table of contents, heap (TOC sha1 first, then the files). */
function xar(files) {
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  let offset = 20;
  let id = 1;
  const heap = [];
  const fileXml = files.map((f) => {
    const sum = sha1(f.data).toString('hex');
    const xml = `  <file id="${id}">
   <data>
    <length>${f.data.length}</length>
    <encoding style="application/octet-stream"/>
    <offset>${offset}</offset>
    <size>${f.data.length}</size>
    <extracted-checksum style="sha1">${sum}</extracted-checksum>
    <archived-checksum style="sha1">${sum}</archived-checksum>
   </data>
   <ctime>${now}</ctime>
   <mtime>${now}</mtime>
   <atime>${now}</atime>
   <group>wheel</group>
   <gid>0</gid>
   <user>root</user>
   <uid>0</uid>
   <mode>0644</mode>
   <deviceno>16777220</deviceno>
   <inode>${id + 100}</inode>
   <type>file</type>
   <name>${f.name}</name>
  </file>`;
    id++;
    offset += f.data.length;
    heap.push(f.data);
    return xml;
  }).join('\n');
  const toc = Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<xar>
 <toc>
  <checksum style="sha1">
   <offset>0</offset>
   <size>20</size>
  </checksum>
  <creation-time>${now.replace('Z', '')}</creation-time>
${fileXml}
 </toc>
</xar>
`, 'utf8');
  const tocZ = zlib.deflateSync(toc, { level: 9 });
  const header = Buffer.alloc(28);
  header.write('xar!', 0, 'ascii');
  header.writeUInt16BE(28, 4);       // header size
  header.writeUInt16BE(1, 6);        // version
  header.writeBigUInt64BE(BigInt(tocZ.length), 8);
  header.writeBigUInt64BE(BigInt(toc.length), 16);
  header.writeUInt32BE(1, 24);       // checksum algorithm: sha1
  return Buffer.concat([header, tocZ, sha1(tocZ), ...heap]);
}

/** A payload-free installer package whose postinstall runs `script` as root. */
export function buildPkg({ identifier, version, script }) {
  const packageInfo = Buffer.from(`<?xml version="1.0" encoding="utf-8"?>
<pkg-info overwrite-permissions="true" relocatable="false" identifier="${identifier}" postinstall-action="none" version="${version}" format-version="2" generator-version="HostPilot" auth="root">
    <bundle-version/>
    <upgrade-bundle/>
    <update-bundle/>
    <atomic-update-bundle/>
    <strict-identifier/>
    <relocate/>
    <scripts>
        <postinstall file="./postinstall"/>
    </scripts>
</pkg-info>
`, 'utf8');
  const scripts = zlib.gzipSync(cpio([{ name: './postinstall', mode: 0o100755, data: Buffer.from(script.replace(/\r\n/g, '\n'), 'utf8') }]));
  return xar([{ name: 'PackageInfo', data: packageInfo }, { name: 'Scripts', data: scripts }]);
}
