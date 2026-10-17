# Ảnh thật dùng trong TVC Én Nam (bản "như quay thật")

Ảnh lấy từ bộ sưu tập hình nền công khai `dharmx/walls` trên GitHub (phần lớn gốc từ Unsplash). **Cần kiểm tra lại giấy phép từng ảnh trước khi dùng thương mại**: kho tổng hợp không ghi tác giả/ giấy phép cho từng file; ảnh Unsplash dùng thương mại được nhưng không được bán lại nguyên bản và không được ngụ ý tác giả ủng hộ thương hiệu.

| Tên chất liệu | File gốc (raw.githubusercontent.com/dharmx/walls/main/…) | Spec |
|---|---|---|
| `fogland` | `nature/a_foggy_landscape_with_trees_and_grass.jpg` | `specs/fogland.json` |
| `river` | `nature/a_river_running_through_a_forest.jpg` | `specs/river.json` |
| `leaf` | `nature/a_close_up_of_leaves_02.jpg` | `specs/leaf.json` |
| `waterfall` | `nature/a_waterfall_over_rocks.jpg` | `specs/waterfall.json` |
| `fogforest` | `nature/a_forest_of_trees_with_fog.jpg` | `specs/fogforest.json` |

Dựng lại:
```bash
mkdir -p /tmp/real && cd /tmp/real
for f in nature/a_foggy_landscape_with_trees_and_grass nature/a_river_running_through_a_forest nature/a_close_up_of_leaves_02 nature/a_waterfall_over_rocks nature/a_forest_of_trees_with_fog; do
  curl -sSLO "https://raw.githubusercontent.com/dharmx/walls/main/$f.jpg"; done
# model độ sâu: https://github.com/fabio-sim/Depth-Anything-ONNX/releases/download/v2.0.0/depth_anything_v2_vits.onnx
P=<repo>/scripts/photo/prep.py; S=<repo>/examples/tvc-en-nam-real/specs
python3 $P a_foggy_landscape_with_trees_and_grass.jpg --name fogland --out assets --spec $S/fogland.json
python3 $P a_river_running_through_a_forest.jpg --name river --out assets --spec $S/river.json
python3 $P a_close_up_of_leaves_02.jpg --name leaf --out assets --spec $S/leaf.json
python3 $P a_waterfall_over_rocks.jpg --name waterfall --out assets --spec $S/waterfall.json
python3 $P a_forest_of_trees_with_fog.jpg --name fogforest --out assets --spec $S/fogforest.json
node scripts/seed-tvc-real.js /tmp/real/assets [mix.wav]
```

## Cây cắt nền (tree-oak, tree-ash, tree-birch, tree-pine)
Ảnh PNG cây tách nền do Danny cung cấp (Project files `IMG_0794`–`IMG_0797`, nguồn kiểu meye.dk). Lưu ý: điều khoản meye.dk không cho dùng cho quảng cáo — chỉ dùng cho bản demo nội bộ; khi lên sóng cần thay bằng ảnh có giấy phép thương mại.
Tải lên dự án với tên `tree-oak` (0794), `tree-ash` (0795), `tree-birch` (0796), `tree-pine` (0797).
