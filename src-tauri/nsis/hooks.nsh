; NSIS 钩子：把桌面 / 开始菜单的快捷方式显式绑到随包安装的 ico 上。
;
; 为什么要这么绕：Tauri 默认的快捷方式不写图标路径，Windows 就去取 exe 内嵌图标。
; 而资源管理器的图标缓存是按「exe 路径」记的——exe 换了图标但路径没变时，
; 缓存命中旧图，用户看到的还是老图标（实测重装 v0.7.0 后桌面快捷方式没变）。
; 给快捷方式一个独立的 ico 文件，缓存键跟着路径走，新图标立刻显示；
; 顺手跑一次 ie4uinit，让已经打开的桌面也重读一遍。

!macro NSIS_HOOK_POSTINSTALL
  ${If} ${FileExists} "$INSTDIR\fy-desktop.ico"
    CreateShortcut "$DESKTOP\fy-desktop.lnk" "$INSTDIR\fy-desktop.exe" "" "$INSTDIR\fy-desktop.ico" 0
    CreateShortcut "$SMPROGRAMS\fy-desktop.lnk" "$INSTDIR\fy-desktop.exe" "" "$INSTDIR\fy-desktop.ico" 0
    ; 刷新 shell 图标缓存（Windows 10/11 都认这个开关，失败也无害）
    ExecShell "" "ie4uinit.exe" "-show" SW_HIDE
  ${EndIf}
!macroend
