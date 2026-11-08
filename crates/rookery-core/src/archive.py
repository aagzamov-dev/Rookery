import os
import pathlib
import shutil
import signal
import stat
import sys
import tarfile
import zipfile

# Rookery's ZIP / tar.gz helper. argv: source, destination name (beside the source), mode.
# Modes: zip, unzip, targz, untargz.
# The result is built under a temporary name and only appears under its real name when it is
# complete, so a failure or a cancel (SIGHUP when Rookery closes the channel) leaves nothing
# half-written behind. It never overwrites anything and never follows or creates links.


def stop(*_):
    raise SystemExit(1)


def safe_member(name, mode_bits, is_dir, is_file):
    path = pathlib.PurePosixPath(name)
    if (path.is_absolute() or ".." in path.parts or "\\" in name
            or not path.parts or ":" in path.parts[0]
            or not (is_dir or is_file)
            or stat.S_ISLNK(mode_bits)):
        raise ValueError("Archive contains an unsafe path or unsupported file type (links, devices).")
    return path.parts


def keep_exec(target, archived_mode):
    """Keep execute permission (scripts); nothing else: no setuid, owners or modes wider
    than this server's umask allows."""
    if archived_mode & 0o111:
        bits = os.stat(target).st_mode & 0o777
        os.chmod(target, bits | ((bits & 0o444) >> 2))


def extract_zip(source, temp):
    with zipfile.ZipFile(source) as archive:
        members = archive.infolist()
        for m in members:
            bits = m.external_attr >> 16
            safe_member(m.filename, bits, m.is_dir(),
                        not m.is_dir() and stat.S_IFMT(bits) in (0, stat.S_IFREG))
        for m in members:
            target = os.path.join(temp, *pathlib.PurePosixPath(m.filename).parts)
            if m.is_dir():
                os.makedirs(target, exist_ok=True)
            else:
                os.makedirs(os.path.dirname(target), exist_ok=True)
                with archive.open(m) as src, open(target, "xb") as dst:
                    shutil.copyfileobj(src, dst)
                keep_exec(target, m.external_attr >> 16)


def extract_tar(source, temp):
    with tarfile.open(source, "r:*") as archive:
        members = archive.getmembers()
        for m in members:
            safe_member(m.name, 0, m.isdir(), m.isreg())
        for m in members:
            target = os.path.join(temp, *pathlib.PurePosixPath(m.name).parts)
            if m.isdir():
                os.makedirs(target, exist_ok=True)
            else:
                os.makedirs(os.path.dirname(target), exist_ok=True)
                src = archive.extractfile(m)
                with src, open(target, "xb") as dst:
                    shutil.copyfileobj(src, dst)
                keep_exec(target, m.mode)


def walk(source):
    """The source and everything inside it; refuses links and special files."""
    def check(path):
        if os.path.islink(path):
            raise ValueError("The folder contains symbolic links; the archive was not created.")
        if not os.path.isdir(path) and not os.path.isfile(path):
            raise ValueError("The folder contains an unsupported file type; the archive was not created.")
        return path

    yield check(source)
    if os.path.isdir(source):
        def walk_error(error):
            raise error

        for root, dirs, files in os.walk(source, onerror=walk_error, followlinks=False):
            for child in sorted(dirs) + sorted(files):
                yield check(os.path.join(root, child))


def create_zip(source, temp):
    with zipfile.ZipFile(temp, "x", compression=zipfile.ZIP_DEFLATED, allowZip64=True) as archive:
        for path in walk(source):
            archive.write(path, os.path.relpath(path, os.path.dirname(source)))


def create_tar(source, temp):
    with tarfile.open(temp, "x:gz") as archive:
        for path in walk(source):
            archive.add(path, os.path.relpath(path, os.path.dirname(source)), recursive=False)


def run():
    source, name, mode = sys.argv[1:]
    source = os.path.abspath(source)
    parent = os.path.dirname(source)
    destination = os.path.join(parent, name)
    if os.path.lexists(destination):
        raise ValueError("Destination already exists. Choose a different name.")
    if os.path.islink(source):
        raise ValueError("Select a regular file or folder, not a symbolic link.")
    extract = mode in ("unzip", "untargz")
    if extract and not os.path.isfile(source):
        raise ValueError("Select an archive file.")
    if not extract and not os.path.isfile(source) and not os.path.isdir(source):
        raise ValueError("Select a regular file or folder.")
    if mode not in ("zip", "unzip", "targz", "untargz"):
        raise ValueError("Unknown archive mode.")

    temp = os.path.join(parent, ".%s.%d.rookery-part" % (name, os.getpid()))
    try:
        if extract:
            os.mkdir(temp, 0o755)
            (extract_zip if mode == "unzip" else extract_tar)(source, temp)
            # Last check right before the rename (rename would replace an empty folder).
            if os.path.lexists(destination):
                raise ValueError("Destination already exists. Choose a different name.")
            os.rename(temp, destination)
        else:
            (create_zip if mode == "zip" else create_tar)(source, temp)
            # link + unlink: refuses an existing destination instead of replacing it.
            try:
                os.link(temp, destination)
            except FileExistsError:
                raise
            except OSError:
                # No hard links on this file system: check, then rename.
                if os.path.lexists(destination):
                    raise ValueError("Destination already exists. Choose a different name.")
                os.rename(temp, destination)
            else:
                os.unlink(temp)
    except BaseException:
        if os.path.isdir(temp) and not os.path.islink(temp):
            shutil.rmtree(temp, ignore_errors=True)
        elif os.path.lexists(temp):
            os.unlink(temp)
        raise


signal.signal(signal.SIGHUP, stop)
signal.signal(signal.SIGTERM, stop)
try:
    run()
except SystemExit:
    print("Cancelled; nothing was created.", file=sys.stderr)
    sys.exit(1)
except FileExistsError:
    print("Destination already exists. Choose a different name.", file=sys.stderr)
    sys.exit(1)
except (tarfile.TarError, zipfile.BadZipFile) as error:
    print("Not a valid archive: %s" % error, file=sys.stderr)
    sys.exit(1)
except Exception as error:
    print(str(error), file=sys.stderr)
    sys.exit(1)
