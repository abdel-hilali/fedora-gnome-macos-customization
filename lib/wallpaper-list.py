#!/usr/bin/python3 -I
"""Print the <wallpaper> entries of an existing list that are not the ones install.sh ships,
so a picture someone added there stays in Settings > Appearance.

  wallpaper-list.py LIST.xml WALLPAPER_DIR
"""
import re
import sys

SHIPPED = re.compile(r'/(mountain|sub-arctic|coast|waterfall|orionids|nuvole)-[ld]\.jpg$')

text = open(sys.argv[1], encoding='utf-8').read()
ours = sys.argv[2].rstrip('/') + '/'
for entry in re.findall(r'[ \t]*<wallpaper\b.*?</wallpaper>', text, re.S):
    files = re.findall(r'<filename(?:-dark)?>(.*?)</filename', entry)
    if files and all(f.startswith(ours) and SHIPPED.search(f) for f in files):
        continue
    print(entry)
