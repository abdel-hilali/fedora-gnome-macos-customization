#!/usr/bin/env python3
"""Write a softened copy of a GTK theme stylesheet: only background colours change.

Usage: soften-css.py [--keep-urls] IN OUT MAPPING.json

MAPPING: {"bars": {colour: new}, "rest": {colour: new}, "vars": {"--name": colour}}. Colours are written as in the
theme (e.g. "#ffffff", "rgba(240, 240, 240, 0.96)"). In a rule whose selectors name a bar
(headerbar, .titlebar, .top-bar, .toolbar, actionbar, searchbar) the "bars" table is used
first, else the "rest" table. Only `background` and `background-color` declarations are
touched, so text, accents and borders stay as they are. "vars" are written at the end as a
:root block (libadwaita's colour variables); "defines" replace the values of
`@define-color NAME VALUE;` lines (named colours some apps read). @import lines are copied
as they are; relative url()s are made absolute to IN's folder, so OUT can live anywhere,
unless --keep-urls is given (OUT sits in a theme folder whose assets link to IN's).

Written 2026-10-12 (plan 05) for a softer WhiteSur-Light.
"""
import json
import os
import re
import sys

args = sys.argv[1:]
keep_urls = '--keep-urls' in args
src, dst, mapping_file = [a for a in args if a != '--keep-urls'][:3]
with open(mapping_file) as f:
    mapping = json.load(f)
bars = {k.lower(): v for k, v in mapping.get('bars', {}).items()}
rest = {k.lower(): v for k, v in mapping.get('rest', {}).items()}

css = open(src).read()
base = os.path.dirname(os.path.abspath(src))

# url(foo.png) -> url("file:///abs/foo.png"), so the copy finds the theme's assets.
def absolute(m):
    target = m.group(2)
    if re.match(r'^[a-z]+:', target) or target.startswith('/'):
        return m.group(0)
    return f'url("file://{os.path.normpath(os.path.join(base, target))}")'

if not keep_urls:
    css = re.sub(r'url\((["\']?)([^)"\']+)\1\)', absolute, css)

defines = mapping.get('defines', {})
css = re.sub(r'(@define-color\s+)([\w-]+)(\s+)([^;]+);',
             lambda m: f'{m.group(1)}{m.group(2)}{m.group(3)}{defines.get(m.group(2), m.group(4))};', css)

BAR = re.compile(r'headerbar|\.titlebar|\.top-bar|\.toolbar|actionbar|searchbar')
DECL = re.compile(r'(background(?:-color)?\s*:\s*)([^;}]+)')
COLOUR = re.compile(r'#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)')
counts = {'bars': 0, 'rest': 0}

def soften_rule(m):
    selectors, body = m.group(1), m.group(2)
    table = bars if BAR.search(selectors) else rest
    which = 'bars' if table is bars else 'rest'

    def soften_decl(d):
        def swap(c):
            key = re.sub(r'\s+', ' ', c.group(0).lower())
            new = table.get(key) or (rest.get(key) if table is bars else None)
            if new:
                counts[which] += 1
                return new
            return c.group(0)
        return d.group(1) + COLOUR.sub(swap, d.group(2))

    return selectors + '{' + DECL.sub(soften_decl, body) + '}'

# Rules without nested blocks: "selectors { declarations }".
css = re.sub(r'([^{}]+)\{([^{}]*)\}', soften_rule, css)
# libadwaita's own colours (CSS variables, libadwaita 1.6 and later) for the widgets the theme
# leaves to libadwaita.
if mapping.get('vars'):
    css += '\n:root {\n' + ''.join(f'  {k}: {v};\n' for k, v in mapping['vars'].items()) + '}\n'
with open(dst, 'w') as f:
    f.write(css)
print(f'{dst}: {counts["bars"]} bar backgrounds, {counts["rest"]} other backgrounds changed')
