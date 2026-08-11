# Proxmox LXC setup — Web Video Editor

Target host verified 2026-08-11:

| | |
|---|---|
| Host | Proxmox VE host with an Intel iGPU |
| Proxmox VE | 9.2.3 (kernel 7.0.6-2-pve) |
| iGPU | Intel TigerLake-LP GT2 / Iris Xe, `8086:9a49` at `00:02.0` |
| Render node | `/dev/dri/renderD128`, device `226:128`, `root:render` 0660 |
| Host `render` GID | **993** |

PVE 9 supports the `dev0:` container device syntax (added in 8.2), which maps a host
device into an unprivileged container and sets its ownership *inside* the container
automatically. This replaces the old `lxc.cgroup2.devices.allow` + `lxc.mount.entry` +
`lxc.idmap` + `/etc/subgid` approach entirely. Use it.

---

## 1. Create the container

Debian 13 template, unprivileged. Adjust CTID (`200`), storage names and network.

```bash
pveam update && pveam available --section system | grep debian-13
pveam download local debian-13-standard_13.1-1_amd64.tar.zst
```

```bash
pct create 200 local:vztmpl/debian-13-standard_13.1-1_amd64.tar.zst \
  --hostname video-editor \
  --unprivileged 1 \
  --cores 3 \
  --memory 4096 \
  --swap 512 \
  --rootfs local-lvm:32 \
  --net0 name=eth0,bridge=vmbr0,ip=dhcp \
  --onboot 1
```

**Why 3 cores and not 4.** TGL-LP GT2 is a 4-core/8-thread mobile part, so 4 cores is
the entire host. Exports are I/O bound so you lose almost nothing, and PVE plus your
other guests stay responsive during a job.

**Why 32 GB rootfs.** Sprite cache plus smart-cut scratch. See the storage table in
`PLAN.md` §5. If you'd rather run leaner, point the temp dir at the output mount and
16 GB is enough.

`--features nesting=1` is only needed if you decide to run Docker inside the container.
The recommended deployment is native systemd units, which need no nesting.

## 2. Pass through the iGPU

```bash
pct set 200 --dev0 /dev/dri/renderD128,uid=0,gid=993
```

**Read the ID semantics carefully — this is where people go wrong.** In `dev0:`, `uid`
and `gid` are the IDs the device node will carry **inside** the container, not on the
host. Proxmox handles the host-side unprivileged mapping itself.

Host `render` is GID 993 because Debian 13's systemd allocates system groups downward
from 999. A freshly created container will allocate *its own* `render` group at whatever
GID happens to be free there — likely not 993. So we pin the in-container GID to 993
explicitly and then create a matching group inside, keeping both sides consistent and
making the whole thing easy to reason about later.

## 3. Mount the media

Replace `/mnt/jbod` with your actual host path.

```bash
pct set 200 --mp0 /mnt/jbod,mp=/media,ro=1
pct set 200 --mp1 /mnt/jbod/exports,mp=/output
```

`ro=1` on the source library is deliberate and not optional — the editor must never be
able to damage the originals. Enforce it at the hypervisor, not just in application
logic.

### ⚠ Write permission on the output mount

This is the second-most-common gotcha after the render GID. In an unprivileged
container, container UID 0 is host UID 100000. So container root has no write access to
a host directory owned by host root. Fix depends on how the JBOD is mounted:

**If `/mnt/jbod` is a local filesystem (ext4/xfs/ZFS):**

```bash
mkdir -p /mnt/jbod/exports
chown -R 100000:100000 /mnt/jbod/exports
```

**If it is an SMB/CIFS mount**, ownership is fixed at mount time and `chown` is
meaningless. Set it in `/etc/fstab` on the host instead:

```
//nas/media /mnt/jbod cifs credentials=/root/.smbcred,uid=100000,gid=100000,iocharset=utf8,vers=3.0 0 0
```

**If it is NFS**, either export with `all_squash,anonuid=100000,anongid=100000`, or
`chown 100000:100000` the exports directory on the NFS server itself.

The read-only source mount usually needs no changes, provided the files are
world-readable (`o+r`), which is typical.

## 4. Start and verify inside the container

```bash
pct start 200 && pct enter 200
```

Everything below runs **inside** the container.

```bash
ls -l /dev/dri/
```

Expect `crw-rw---- 1 root 993 226, 128 ... renderD128`. If you see `nobody` or the node
is missing entirely, step 2 did not apply — stop the container and re-check the config
with `pct config 200`.

Create the matching group and the service account:

```bash
groupadd -g 993 render 2>/dev/null || groupmod -g 993 render
useradd -r -s /usr/sbin/nologin -G render -m -d /var/lib/veditor veditor
id veditor
```

Debian 13 needs the `non-free` component for the Intel media driver:

```bash
sed -i 's/^Components: main$/Components: main contrib non-free non-free-firmware/' \
  /etc/apt/sources.list.d/debian.sources
apt update
apt install -y ffmpeg vainfo intel-media-va-driver-non-free
```

`intel-media-va-driver-non-free` is the iHD driver and is the correct one for Gen12
(Tiger Lake). The free `intel-media-va-driver` package has codec gaps. Do not install
`i965-va-driver` — that is for pre-Broadwell hardware and will not bind here.

### Verify VA-API

```bash
vainfo --display drm --device /dev/dri/renderD128
```

You want to see `Driver version: Intel iHD driver ...` and entries including:

```
VAProfileH264Main   : VAEntrypointVLD        <- decode, what the plan needs
VAProfileH264Main   : VAEntrypointEncSliceLP
VAProfileHEVCMain   : VAEntrypointVLD
VAProfileHEVCMain10 : VAEntrypointVLD
VAProfileAV1Profile0: VAEntrypointVLD        <- TGL has AV1 decode, no AV1 encode
```

### Verify as the service user, not as root

Root inside the container can often open the node even when group mapping is wrong.
This is the test that actually matters:

```bash
sudo -u veditor vainfo --display drm --device /dev/dri/renderD128 | head -5
```

### End-to-end ffmpeg test

```bash
sudo -u veditor ffmpeg -hide_banner \
  -init_hw_device vaapi=hw:/dev/dri/renderD128 \
  -f lavfi -i testsrc=size=1280x720:rate=30:duration=3 \
  -vf 'format=nv12,hwupload' -c:v h264_vaapi -f null -
```

Clean exit means hardware encode works end to end as the unprivileged service user.
For the project's actual needs, hardware *decode* is the important half — the plan
deliberately uses CPU libx264 for boundary fragments (see `PLAN.md` §2.3).

Confirm QSV is compiled into Debian's ffmpeg:

```bash
ffmpeg -hide_banner -hwaccels
```

## 5. Sanity-check the mounts

```bash
ls /media | head
touch /output/.write-test && rm /output/.write-test && echo "output writable"
touch /media/.write-test 2>&1 | grep -q 'Read-only' && echo "source correctly read-only"
```

All three should behave as labelled before you go further.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `/dev/dri` missing in container | `dev0:` not applied; container needs a full stop/start, not reboot |
| Node shows owner `nobody` | `gid=` omitted from the `dev0:` line |
| Works as root, fails as `veditor` | In-container `render` group GID does not match the `gid=` value |
| `vainfo: VA-API version ... failed` | Wrong driver package; must be `intel-media-va-driver-non-free` |
| Permission denied writing `/output` | Host dir not owned by 100000:100000 — see §3 |
| ffmpeg has no `qsv` in `-hwaccels` | Debian ffmpeg build lacks it; VAAPI path works regardless |
