# this file is just for nix users and will not affect anyone else.
{ pkgs ? import <nixpkgs> {} }:
  pkgs.mkShell {
    # nativeBuildInputs is usually what you want -- tools you need to run
    nativeBuildInputs = with pkgs; [
      nodejs-14_x
      systemd
    ];
}
