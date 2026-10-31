import os
import pathlib
import shutil
import stat
import sys
import zipfile


def run():
    source, name, extract = sys.argv[1:]
    source = os.path.abspath(source)
    destination = os.path.join(os.path.dirname(source), name)
    if os.path.lexists(destination):
        raise ValueError("Destination already exists. Choose a different name.")
    if os.path.islink(source):
        raise ValueError("Select a regular file or folder, not a symbolic link.")

    if extract == "1":
        with zipfile.ZipFile(source) as archive:
            members = archive.infolist()
            for member in members:
                path = pathlib.PurePosixPath(member.filename)
                mode = member.external_attr >> 16
                if (path.is_absolute() or ".." in path.parts or "\\" in member.filename
                        or not path.parts or ":" in path.parts[0]
                        or stat.S_ISLNK(mode)
                        or stat.S_IFMT(mode) not in (0, stat.S_IFREG, stat.S_IFDIR)):
                    raise ValueError("Archive contains an unsafe path or unsupported file type.")
            os.mkdir(destination)
            for member in members:
                target = os.path.join(destination, *pathlib.PurePosixPath(member.filename).parts)
                if member.is_dir():
                    os.makedirs(target, exist_ok=True)
                else:
                    os.makedirs(os.path.dirname(target), exist_ok=True)
                    with archive.open(member) as src, open(target, "xb") as dst:
                        shutil.copyfileobj(src, dst)
    else:
        if not os.path.isfile(source) and not os.path.isdir(source):
            raise ValueError("Select a regular file or folder.")
        with zipfile.ZipFile(destination, "x", compression=zipfile.ZIP_DEFLATED, allowZip64=True) as archive:
            def add(path):
                if os.path.islink(path):
                    raise ValueError("Folder contains symbolic links; ZIP was not completed.")
                if not os.path.isdir(path) and not os.path.isfile(path):
                    raise ValueError("Folder contains an unsupported file type; ZIP was not completed.")
                archive.write(path, os.path.relpath(path, os.path.dirname(source)))

            add(source)
            if os.path.isdir(source):
                def walk_error(error):
                    raise error

                for root, dirs, files in os.walk(source, onerror=walk_error, followlinks=False):
                    for child in dirs + files:
                        add(os.path.join(root, child))


try:
    run()
except Exception as error:
    print(str(error), file=sys.stderr)
    sys.exit(1)
