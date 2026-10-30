<?php
// Server-owned model mapping. Never accept modelPath or thumbnailPath from a design.
// Reuse approved assets already hosted by the issuer; do not treat these
// visual references as proof of ownership, or as authorization to mint.
function atlas_studio_model_for_template($template) {
  $approved = [
    'trophy'=>['modelPath'=>'/assets/trophy.glb','thumbnailPath'=>'/assets/trophy.png'],
    'badge'=>['modelPath'=>'/assets/badge.glb','thumbnailPath'=>'/assets/badge.png'],
    // This is an explicitly temporary placeholder until a reviewed key model exists.
    'key'=>['modelPath'=>'/assets/compass.glb','thumbnailPath'=>'/assets/compass.png'],
  ];
  return is_string($template) ? ($approved[$template] ?? null) : null;
}
