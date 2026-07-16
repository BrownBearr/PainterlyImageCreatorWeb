"""Export the Paint Transformer stroke predictor to ONNX for in-browser use.

Paint Transformer (Liu et al., ICCV 2021), MIT-licensed re-implementation:
https://github.com/Huage001/PaintTransformer

Only the stroke-prediction network is exported (conv encoders + transformer +
linear heads). Everything else in the official pipeline — color sampling at
stroke centers, the patch pyramid, and rasterization — is reimplemented in
neural.js on top of the app's own stroke renderer, which sidesteps the
grid_sample/unfold ops that do not export cleanly.

Inputs  : img    float32 [N, 3, 32, 32]   target image patches, RGB 0..1
          canvas float32 [N, 3, 32, 32]   current canvas patches, RGB 0..1
Outputs : param    float32 [N, 8, 5]      per stroke: x, y, w, h, theta (0..1,
                                          patch-local; theta in units of pi)
          decision float32 [N, 8, 1]      draw the stroke iff logit > 0

Usage:
  python convert_paint_transformer.py <model.pth> <out_dir>

Produces <out_dir>/paint-transformer-v1.fp16.onnx and runs a torch-vs-ONNX
self-check on random inputs before writing.
"""

import math
import sys
import os

import numpy as np
import torch
import torch.nn as nn


PATCH = 32
STROKES = 8
PARAMS = 5


class Painter(nn.Module):
    """Verbatim architecture from the official network.py (inference parts)."""

    def __init__(self, param_per_stroke, total_strokes, hidden_dim,
                 n_heads=8, n_enc_layers=3, n_dec_layers=3):
        super().__init__()

        def encoder():
            return nn.Sequential(
                nn.ReflectionPad2d(1), nn.Conv2d(3, 32, 3, 1),
                nn.BatchNorm2d(32), nn.ReLU(True),
                nn.ReflectionPad2d(1), nn.Conv2d(32, 64, 3, 2),
                nn.BatchNorm2d(64), nn.ReLU(True),
                nn.ReflectionPad2d(1), nn.Conv2d(64, 128, 3, 2),
                nn.BatchNorm2d(128), nn.ReLU(True))

        self.enc_img = encoder()
        self.enc_canvas = encoder()
        self.conv = nn.Conv2d(128 * 2, hidden_dim, 1)
        self.transformer = nn.Transformer(hidden_dim, n_heads, n_enc_layers, n_dec_layers)
        self.linear_param = nn.Sequential(
            nn.Linear(hidden_dim, hidden_dim), nn.ReLU(True),
            nn.Linear(hidden_dim, hidden_dim), nn.ReLU(True),
            nn.Linear(hidden_dim, param_per_stroke))
        self.linear_decider = nn.Linear(hidden_dim, 1)
        self.query_pos = nn.Parameter(torch.rand(total_strokes, hidden_dim))
        self.row_embed = nn.Parameter(torch.rand(8, hidden_dim // 2))
        self.col_embed = nn.Parameter(torch.rand(8, hidden_dim // 2))

    def forward(self, img, canvas):
        b = img.shape[0]
        feat = torch.cat([self.enc_img(img), self.enc_canvas(canvas)], dim=1)
        feat_conv = self.conv(feat)
        h, w = feat_conv.shape[-2:]
        pos_embed = torch.cat([
            self.col_embed[:w].unsqueeze(0).repeat(h, 1, 1),
            self.row_embed[:h].unsqueeze(1).repeat(1, w, 1),
        ], dim=-1).flatten(0, 1).unsqueeze(1)
        hidden = self.transformer(
            pos_embed + feat_conv.flatten(2).permute(2, 0, 1),
            self.query_pos.unsqueeze(1).repeat(1, b, 1))
        hidden = hidden.permute(1, 0, 2)
        return self.linear_param(hidden), self.linear_decider(hidden)


def main(model_path, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    out_fp32 = os.path.join(out_dir, "paint-transformer-v1.fp32.onnx")
    out_fp16 = os.path.join(out_dir, "paint-transformer-v1.fp16.onnx")

    net = Painter(PARAMS, STROKES, 256, 8, 3, 3)
    net.load_state_dict(torch.load(model_path, map_location="cpu", weights_only=True))
    net.eval()
    for p in net.parameters():
        p.requires_grad = False

    torch.manual_seed(7)
    img = torch.rand(3, 3, PATCH, PATCH)
    canvas = torch.rand(3, 3, PATCH, PATCH)

    torch.onnx.export(
        net, (img, canvas), out_fp32,
        input_names=["img", "canvas"],
        output_names=["param", "decision"],
        dynamic_axes={"img": {0: "batch"}, "canvas": {0: "batch"},
                      "param": {0: "batch"}, "decision": {0: "batch"}},
        opset_version=17,
        dynamo=False,
    )

    import onnx
    # onnxruntime's transformer-aware fp16 converter. onnxconverter-common's
    # generic one corrupts the Cast/Div nodes inside the exported attention
    # layers (mixed fp16/fp32 inputs) and its shape-inference pass hangs on
    # this graph — do not switch back.
    from onnxruntime.transformers.onnx_model import OnnxModel
    model = OnnxModel(onnx.load(out_fp32))
    model.convert_float_to_float16(keep_io_types=True)
    onnx.save(model.model, out_fp16)

    # Self-check: torch vs ONNX Runtime on fresh random input, both precisions.
    import onnxruntime as ort
    img2 = torch.rand(5, 3, PATCH, PATCH)
    canvas2 = torch.rand(5, 3, PATCH, PATCH)
    with torch.no_grad():
        ref_param, ref_dec = net(img2, canvas2)
    feeds = {"img": img2.numpy(), "canvas": canvas2.numpy()}
    for path, tol in ((out_fp32, 1e-4), (out_fp16, 3e-2)):
        sess = ort.InferenceSession(path, providers=["CPUExecutionProvider"])
        got_param, got_dec = sess.run(None, feeds)
        dp = np.abs(got_param - ref_param.numpy()).max()
        dd = np.abs(got_dec - ref_dec.numpy()).max()
        # Decisions only matter by sign; check agreement too.
        sign_ok = ((got_dec > 0) == (ref_dec.numpy() > 0)).mean()
        status = "OK" if (dp < tol and dd < tol * 10) else "FAIL"
        print(f"{os.path.basename(path)}: max|dparam|={dp:.2e} max|ddec|={dd:.2e} "
              f"decision-sign-agreement={sign_ok:.3f} [{status}]")
        if status == "FAIL":
            sys.exit(1)

    for f in (out_fp32, out_fp16):
        print(f"{f}: {os.path.getsize(f) / 1e6:.1f} MB")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "model.pth",
         sys.argv[2] if len(sys.argv) > 2 else ".")
