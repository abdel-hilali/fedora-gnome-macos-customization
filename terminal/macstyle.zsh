# macstyle: the terminal look for zsh. ~/.zshrc sources this file at its end (install.sh adds
# that line). It works on a bare zsh and on top of Oh My Zsh or an existing Powerlevel10k setup.
# Each part is skipped when its Fedora package is missing.

# A comfortable zsh, only when no framework (Oh My Zsh) has set one up already.
if (( ! $+functions[omz] )); then
  HISTFILE=${HISTFILE:-$HOME/.zsh_history}
  HISTSIZE=50000
  SAVEHIST=10000
  setopt extended_history hist_expire_dups_first hist_ignore_dups hist_ignore_space hist_verify
  setopt share_history auto_cd auto_pushd pushd_ignore_dups interactive_comments
  autoload -Uz compinit
  compinit -i -d "${XDG_CACHE_HOME:-$HOME/.cache}/zcompdump-$ZSH_VERSION"
  zstyle ':completion:*' menu select
  zstyle ':completion:*' matcher-list 'm:{a-zA-Z}={A-Za-z}' 'r:|=*' 'l:|=* r:|=*'
  bindkey -e
  bindkey '^[[H' beginning-of-line
  bindkey '^[OH' beginning-of-line
  bindkey '^[[F' end-of-line
  bindkey '^[OF' end-of-line
  bindkey '^[[3~' delete-char
  bindkey '^[[1;5C' forward-word
  bindkey '^[[1;5D' backward-word
  autoload -Uz up-line-or-beginning-search down-line-or-beginning-search
  zle -N up-line-or-beginning-search
  zle -N down-line-or-beginning-search
  bindkey '^[[A' up-line-or-beginning-search
  bindkey '^[OA' up-line-or-beginning-search
  bindkey '^[[B' down-line-or-beginning-search
  bindkey '^[OB' down-line-or-beginning-search
fi

# The prompt: Powerlevel10k as round pills. The copy install.sh downloads is loaded here, unless
# the lines above this file have loaded Powerlevel10k already.
typeset -g _macstyle_p10k_dir=${XDG_DATA_HOME:-$HOME/.local/share}/macstyle/powerlevel10k
if (( ! $+functions[p10k] )) && [[ -r $_macstyle_p10k_dir/powerlevel10k.zsh-theme ]]; then
  source $_macstyle_p10k_dir/powerlevel10k.zsh-theme
  [[ -r ~/.p10k.zsh ]] && source ~/.p10k.zsh
fi
if (( $+functions[p10k] )); then
  # No settings of its own: macstyle's base settings (p10k-base.zsh, next to this file).
  if (( ! $+parameters[POWERLEVEL9K_LEFT_PROMPT_ELEMENTS] )); then
    source ${${(%):-%x}:A:h}/p10k-base.zsh
  fi
  typeset -g POWERLEVEL9K_DISABLE_CONFIGURATION_WIZARD=true
  source ${${(%):-%x}:A:h}/p10k-macstyle.zsh
fi
unset _macstyle_p10k_dir

# A grey suggestion from your history as you type; → or End accepts it.
if [[ -r /usr/share/zsh-autosuggestions/zsh-autosuggestions.zsh ]]; then
  ZSH_AUTOSUGGEST_STRATEGY=(history completion)
  source /usr/share/zsh-autosuggestions/zsh-autosuggestions.zsh
fi

# Ctrl+R searches your history as you type; Ctrl+T picks a file; Alt+C goes into a folder.
if (( $+commands[fzf] )); then
  export FZF_DEFAULT_OPTS='--color=16 --height=45% --layout=reverse --border=rounded --info=inline-right'
  source <(fzf --zsh)
fi

# z NAME jumps to a folder you used before; zi picks one from a list.
if (( $+commands[zoxide] )); then
  eval "$(zoxide init zsh)"
fi

# ls with icons and colours, folders first (~/.config/lsd). Not in the shells of tools like
# Claude Code, whose output must stay plain.
if (( $+commands[lsd] )) && [[ -z $CLAUDECODE ]]; then
  alias ls='lsd' ll='lsd -l' la='lsd -A' lla='lsd -lA' lt='lsd --tree --depth=2'
fi

# Commands turn green when they exist and red when they don't. Must come last.
if [[ -r /usr/share/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh ]]; then
  source /usr/share/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh
fi
