# macstyle: Powerlevel10k as round pills in the desktop's colours, light or dark with Dark Style.
# Sourced by macstyle.zsh after the Powerlevel10k settings (~/.p10k.zsh or the rainbow style
# Powerlevel10k ships), whose other choices (transient prompt, time format...) stay.
# Needs a Nerd Font in the terminal (macstyle uses JetBrainsMono Nerd Font).

(( ${+_macstyle_p10k_done} )) && return   # once per shell
typeset -g _macstyle_p10k_done=1

# Colour roles: "pill-background text" for light and for dark.
typeset -gA _macstyle_pill_light=(
  neutral '#e8e8ed #55555b'  os    '#e8e8ed #3c6eb4'  blue   '#dce8fd #0b4fc8'
  green   '#dbf1e2 #1d7038'  amber '#fcefd2 #8a5800'  red    '#fde1de #b3261e'
  purple  '#efe4fb #7438b0'  teal  '#dcf0f5 #0a6a80'  accent '#f7f7f8 #0860f2'
)
typeset -gA _macstyle_pill_dark=(
  neutral '#3a3a3f #c7c7cc'  os    '#3a3a3f #8ab4ff'  blue   '#1e3a64 #b9d4ff'
  green   '#1d4a2e #a6e8b9'  amber '#4d3a10 #ffd98a'  red    '#5b2420 #ffb4ab'
  purple  '#3f2a57 #dcbcff'  teal  '#18414d #a3e4f3'  accent '#242424 #4c9bff'
)
typeset -gA _macstyle_pill

# side (L left, R right), segment or segment_STATE, colour role
typeset -ga _macstyle_pills=(
  L OS_ICON os                  L DIR blue                   L DIR_NOT_WRITABLE amber
  L VCS_CLEAN green             L VCS_MODIFIED amber         L VCS_UNTRACKED amber
  L VCS_CONFLICTED red          L VCS_LOADING neutral
  R STATUS_ERROR red            R STATUS_ERROR_SIGNAL red    R STATUS_ERROR_PIPE red
  R COMMAND_EXECUTION_TIME purple                            R BACKGROUND_JOBS teal
  R DIRENV teal                 R VIRTUALENV teal            R ANACONDA teal
  R PYENV teal                  R NODEENV teal               R NVM teal
  R NODENV teal                 R NODE_VERSION green         R TOOLBOX purple
  R CONTEXT neutral             R CONTEXT_ROOT red           R TIME neutral
)

typeset -g POWERLEVEL9K_MODE=nerdfont-v3
typeset -g POWERLEVEL9K_ICON_PADDING=moderate
typeset -g POWERLEVEL9K_LEFT_PROMPT_ELEMENTS=(os_icon dir vcs newline prompt_char)
typeset -g POWERLEVEL9K_RIGHT_PROMPT_ELEMENTS=(
  status command_execution_time background_jobs direnv virtualenv anaconda pyenv nodeenv nvm
  nodenv node_version toolbox context time newline
)
# No joined blocks: each segment is its own pill, round ends drawn by the whitespace below.
typeset -g POWERLEVEL9K_{LEFT,RIGHT}_{SEGMENT,SUBSEGMENT}_SEPARATOR=
typeset -g POWERLEVEL9K_{LEFT,RIGHT}_PROMPT_{FIRST_SEGMENT_START,LAST_SEGMENT_END}_SYMBOL=
typeset -g POWERLEVEL9K_MULTILINE_{FIRST,NEWLINE,LAST}_PROMPT_{PREFIX,SUFFIX}=
typeset -g POWERLEVEL9K_MULTILINE_FIRST_PROMPT_GAP_CHAR=' '
typeset -g POWERLEVEL9K_PROMPT_ADD_NEWLINE=true
typeset -g POWERLEVEL9K_STATUS_OK=false POWERLEVEL9K_STATUS_OK_PIPE=false
typeset -g POWERLEVEL9K_DIR_ANCHOR_BOLD=true
typeset -g POWERLEVEL9K_PROMPT_CHAR_BACKGROUND=
typeset -g POWERLEVEL9K_PROMPT_CHAR_LEFT_{LEFT,RIGHT}_WHITESPACE=
typeset -g POWERLEVEL9K_PROMPT_CHAR_{OK,ERROR}_{VIINS,VICMD,VIVIS,VIOWR}_CONTENT_EXPANSION='❯'

# Git text in the pill's own colour: green when clean, amber with changes, red with conflicts.
function _macstyle_git_formatter() {
  emulate -L zsh
  local role=neutral
  if (( $1 )); then
    if (( VCS_STATUS_HAS_CONFLICTED )); then role=red
    elif (( VCS_STATUS_HAS_STAGED || VCS_STATUS_HAS_UNSTAGED || VCS_STATUS_HAS_UNTRACKED )); then role=amber
    else role=green
    fi
  fi
  local c="%F{${_macstyle_pill[$role]#* }}" res
  if [[ -n $VCS_STATUS_LOCAL_BRANCH ]]; then
    local branch=${(V)VCS_STATUS_LOCAL_BRANCH}
    (( $#branch > 32 )) && branch[13,-13]="…"
    res+="$c${(g::)POWERLEVEL9K_VCS_BRANCH_ICON}${branch//\%/%%}"
  elif [[ -n $VCS_STATUS_TAG ]]; then
    res+="$c#${${(V)VCS_STATUS_TAG}//\%/%%}"
  else
    res+="$c@${VCS_STATUS_COMMIT[1,8]}"
  fi
  (( $1 )) || { typeset -g _macstyle_git_format=$res; return }
  (( VCS_STATUS_COMMITS_BEHIND )) && res+=" ⇣${VCS_STATUS_COMMITS_BEHIND}"
  (( VCS_STATUS_COMMITS_AHEAD )) && res+=" ⇡${VCS_STATUS_COMMITS_AHEAD}"
  (( VCS_STATUS_STASHES )) && res+=" *${VCS_STATUS_STASHES}"
  [[ -n $VCS_STATUS_ACTION ]] && res+=" ${VCS_STATUS_ACTION}"
  (( VCS_STATUS_NUM_CONFLICTED )) && res+=" ~${VCS_STATUS_NUM_CONFLICTED}"
  (( VCS_STATUS_NUM_STAGED )) && res+=" +${VCS_STATUS_NUM_STAGED}"
  (( VCS_STATUS_NUM_UNSTAGED )) && res+=" !${VCS_STATUS_NUM_UNSTAGED}"
  (( VCS_STATUS_NUM_UNTRACKED )) && res+=" ?${VCS_STATUS_NUM_UNTRACKED}"
  (( VCS_STATUS_HAS_UNSTAGED == -1 )) && res+=" ─"
  typeset -g _macstyle_git_format=$res
}
functions -M _macstyle_git_formatter 2>/dev/null
typeset -g POWERLEVEL9K_VCS_BRANCH_ICON=$'\uF418 '
typeset -g POWERLEVEL9K_VCS_DISABLE_GITSTATUS_FORMATTING=true
typeset -g POWERLEVEL9K_VCS_CONTENT_EXPANSION='${$((_macstyle_git_formatter(1)))+${_macstyle_git_format}}'
typeset -g POWERLEVEL9K_VCS_LOADING_CONTENT_EXPANSION='${$((_macstyle_git_formatter(0)))+${_macstyle_git_format}}'
typeset -g POWERLEVEL9K_VCS_{STAGED,UNSTAGED,UNTRACKED,CONFLICTED,COMMITS_AHEAD,COMMITS_BEHIND}_MAX_NUM=-1

# Set every pill's colours and round ends for light or dark.
function _macstyle_prompt_colors() {
  emulate -L zsh
  if [[ $1 == dark ]]; then _macstyle_pill=("${(@kv)_macstyle_pill_dark}")
  else _macstyle_pill=("${(@kv)_macstyle_pill_light}"); fi
  local side name role bg fg s
  for side name role in $_macstyle_pills; do
    bg=${_macstyle_pill[$role]% *} fg=${_macstyle_pill[$role]#* }
    [[ $side == L ]] && s=LEFT || s=RIGHT
    typeset -g POWERLEVEL9K_${name}_BACKGROUND=$bg POWERLEVEL9K_${name}_FOREGROUND=$fg
    # A gap, the left round end, then the pill; at the far left of the prompt, no gap.
    if [[ $name == OS_ICON ]]; then
      typeset -g POWERLEVEL9K_${name}_${s}_LEFT_WHITESPACE="%k%F{$bg}"$''"%K{$bg} "
    else
      typeset -g POWERLEVEL9K_${name}_${s}_LEFT_WHITESPACE="%k %F{$bg}"$''"%K{$bg} "
    fi
    typeset -g POWERLEVEL9K_${name}_${s}_RIGHT_WHITESPACE=" %k%F{$bg}"$''
  done
  fg=${_macstyle_pill[blue]#* }
  typeset -g POWERLEVEL9K_DIR_SHORTENED_FOREGROUND=$fg POWERLEVEL9K_DIR_ANCHOR_FOREGROUND=$fg
  fg=${_macstyle_pill[amber]#* }
  typeset -g POWERLEVEL9K_DIR_NOT_WRITABLE_SHORTENED_FOREGROUND=$fg POWERLEVEL9K_DIR_NOT_WRITABLE_ANCHOR_FOREGROUND=$fg
  typeset -g POWERLEVEL9K_PROMPT_CHAR_OK_{VIINS,VICMD,VIVIS,VIOWR}_FOREGROUND=${_macstyle_pill[accent]#* }
  typeset -g POWERLEVEL9K_PROMPT_CHAR_ERROR_{VIINS,VICMD,VIVIS,VIOWR}_FOREGROUND=${_macstyle_pill[red]#* }
}

# Follow Dark Style: dconf writes its database file anew on every change, so a changed file
# (inode and time) is the cheap signal to ask GNOME for the colour scheme again.
zmodload -F zsh/stat b:zstat 2>/dev/null
typeset -g _macstyle_scheme= _macstyle_dconf_stamp=
function _macstyle_follow_scheme() {
  emulate -L zsh
  local -a st
  local db=${XDG_CONFIG_HOME:-$HOME/.config}/dconf/user
  [[ $GSETTINGS_BACKEND == keyfile ]] && db=${XDG_CONFIG_HOME:-$HOME/.config}/glib-2.0/settings/keyfile
  zstat -A st +inode +mtime -- $db 2>/dev/null || st=(-)
  [[ "$st" == "$_macstyle_dconf_stamp" && -n $_macstyle_scheme ]] && return
  _macstyle_dconf_stamp="$st"
  local new=light
  [[ "$(gsettings get org.gnome.desktop.interface color-scheme 2>/dev/null)" == *dark* ]] && new=dark
  [[ $new == $_macstyle_scheme ]] && return
  _macstyle_scheme=$new
  _macstyle_prompt_colors $new
  (( $+functions[p10k] && ${_macstyle_reload_ok:-0} )) && p10k reload
}
_macstyle_follow_scheme
typeset -g _macstyle_reload_ok=1
autoload -Uz add-zsh-hook
add-zsh-hook precmd _macstyle_follow_scheme
