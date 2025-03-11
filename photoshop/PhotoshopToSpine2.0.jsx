#target photoshop
app.bringToFront();

// https://github.com/EsotericSoftware/spose-scripts/tree/master/photoshop
// 本脚本将Adobe Photoshop图层导出为独立PNG文件，并生成可导入Spine的JSON文件
// 导出的图片将在Spine中保持相同的位置和绘制顺序

// 版权所有 (c) 2012-2022, Esoteric Software
// 保留所有权利
// 在满足以下条件的前提下，允许以源代码或二进制形式进行再分发和使用（无论是否修改）：
//     * 再分发源代码时必须保留上述版权声明、本条件列表和以下免责声明
//     * 以二进制形式再分发时，必须在文档和/或其他提供的材料中复制上述版权声明、本条件列表和以下免责声明
//     * 未经事先书面许可，不得使用Esoteric Software的名称或其贡献者名称来认可或推广基于本软件的衍生产品
// 本软件按原样提供，版权持有者和贡献者不对任何明示或暗示的担保负责，包括但不限于适销性和特定用途适用性的暗示担保
// 在任何情况下，版权持有者或贡献者均不对任何直接、间接、偶然、特殊、惩戒性或后果性损害（包括但不限于替代商品或服务的采购、使用损失、数据或利润损失、业务中断）承担任何责任
// 无论因何种原因（合同责任、严格责任或侵权行为，包括疏忽或其他原因）造成，即使已被告知可能发生此类损害

var scriptVersion = "7.50"; // This is incremented every time the script is modified, so you know if you have the latest.

var revealAll = false; // Set to true to enlarge the canvas so layers are not cropped.
var legacyJson = true; // Set to false to output the newer Spine JSON format.

var cs2 = parseInt(app.version) < 10, cID = charIDToTypeID, sID = stringIDToTypeID, tID = typeIDToStringID;

var originalDoc, settings, progress, cancel, errors, lastLayerName;
try {
	originalDoc = activeDocument;
} catch (ignored) {}

var defaultSettings = {
	ignoreHiddenLayers: false, // 忽略隐藏图层
	ignoreBackground: true, // 忽略背景图层
	writeTemplate: false, // 生成模板图像
	writeJson: true, // 生成JSON文件
	trimWhitespace: true, // 修剪空白区域
	selectionOnly: false, // 仅处理选中图层
	scale: 1, // 缩放比例
	padding: 1, // 出血像素
	imagesDir: "./images/", // 图像输出目录
	jsonPath: "./", // JSON输出路径
};
loadSettings();

function run () {
	showProgress();

	var selectedLayers;
	if (settings.selectionOnly) {
		selectedLayers = getSelectedLayers();
		if (!selectedLayers.length) {
			alert("当勾选'仅处理选中图层'时，必须至少选择一个图层。");
			return;
		}
	}

	errors = [];

	// Output dirs.
	var jsonFile = new File(jsonPath(settings.jsonPath));
	jsonFile.parent.create();
	var imagesDir = absolutePath(settings.imagesDir);
	var imagesFolder = new Folder(imagesDir);
	imagesFolder.create();

	var docWidth = originalDoc.width.as("px"), docHeight = originalDoc.height.as("px");
	var xOffSet = rulerOrigin("H"), yOffSet = rulerOrigin("V");

	try {
		deleteDocumentAncestorsMetadata();
	} catch (ignored) {}

	originalDoc.duplicate();
	deselectLayers();

	if (revealAll) activeDocument.revealAll();

	try {
		convertToRGB();
	} catch (ignored) {}
	if (activeDocument.mode != DocumentMode.RGB) {
		alert("请将图像模式更改为RGB颜色。");
		return;
	}

	// Output template image.
	if (settings.writeTemplate) {
		if (settings.scale != 1) {
			storeHistory();
			scaleImage(settings.scale);
		}

		var file = new File(imagesDir + "template.png");
		if (file.exists) file.remove();

		savePNG(file);

		if (settings.scale != 1) restoreHistory();
	}

	if (!settings.jsonPath && !settings.imagesDir) return;

	rasterizeAll();

	// Add a history item to prevent layer visibility from changing by the active layer being reset to the top.
	var topLayer = activeDocument.artLayers.add();
	topLayer.name = "正在收集图层...";

	// Collect and hide layers.
	var rootLayers = [], layers = [];
	var context = {
		first: hasBackgroundLayer() ? 0 : 1,
		index: getLayerCount() - 1,
		total: 0
	};
	initializeLayers(context, selectedLayers, null, rootLayers);
	showProgress("正在收集图层...", context.total);
	collectLayers(rootLayers, layers, []);

	// Store the bones, slot names, and layers for each skin.
	var bones = { _root: { name: "root", x: 0, y: 0, children: [] } };
	var slots = {}, slotsCount = 0;
	var skins = { _default: [] }, skinsCount = 0;
	var skinDuplicates = {};
	var totalLayerCount = 0;
	outer:
	for (var i = layers.length - 1; i >= 0; i--) {
		if (cancel) return;
		var layer = layers[i];

		var name = stripTags(layer.name).replace(/.png$/, "");
		name = name.replace(/[\\:"*?<>|]/g, "").replace(/^\.+$/, "").replace(/^__drag$/, ""); // Illegal.
		name = layer.applyNamePatterns(name);
		if (!name) continue;
		name = name.replace(/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i, ""); // Windows.
		if (!name || name.length > 255) {
			error("Layer name is not a valid attachment name:\n\n" + layer.name);
			continue;
		}

		var folderPath = layer.folders("");
		if (startsWith(name, "/")) {
			name = name.substring(1);
			layer.attachmentName = name;
		} else
			layer.attachmentName = folderPath + name;

		layer.attachmentPath = layer.findTagValue("path:");
		if (!layer.attachmentPath)
			layer.attachmentPath = layer.attachmentName;
		else if (startsWith(layer.attachmentPath, "/"))
			layer.attachmentPath = layer.attachmentPath.substring(1);
		else
			layer.attachmentPath = folderPath + layer.attachmentPath;

		var scale = layer.findTagValue("scale:");
		if (!scale) scale = 1;
		layer.scale = parseFloat(scale);
		if (isNaN(layer.scale)) error("Invalid scale " + scale + ":\n\n" + layer.path());

		var bone = null, boneLayer = layer.findTagLayer("bone");
		if (boneLayer) {
			var parent = boneLayer.getParentBone(bones);
			var boneName = boneLayer.findTagValue("bone");
			bone = get(bones, boneName);
			if (bone) {
				if (parent != bone.parent) {
					error("Multiple layers for the \"" + boneName + "\" bone have different parent bones:\n\n"
						+ bone.layer.path() + "\n"
						+ boneLayer.path());
					continue;
				}
			} else {
				set(bones, boneName, bone = { name: boneName, parent: parent, children: [], layer: boneLayer });
				parent.children.push(bone);
			}
			layer.updateBounds();
			bone.x = layer.left * settings.scale - settings.padding;
			bone.x += layer.width * settings.scale / 2 + settings.padding;
			bone.y = layer.bottom * settings.scale + settings.padding;
			bone.y -= layer.height * settings.scale / 2 + settings.padding;
			bone.y = docHeight * settings.scale - bone.y;
			// Make relative to the Photoshop document ruler origin.
			bone.x -= xOffSet * settings.scale;
			bone.y -= (docHeight - yOffSet) * settings.scale;
		}

		var skinName = null;
		var skinLayer = layer.findTagLayer("skin");
		if (skinLayer) {
			skinName = skinLayer.getTagValue("skin");
			if (startsWith(skinName, "/"))
				skinName = skinName.substring(1);
			else if (skinLayer.parent)
				skinName = skinLayer.parent.folders("") + skinName;
			if (skinName && skinName.toLowerCase() == "default") {
				error("The skin name \"default\" is reserved:\n\n" + layer.path() + "\n\nPlease use a different name.");
				continue;
			}
		}
		if (!skinName) skinName = "default";
		layer.skinName = skinName;

		if (skinName == "default")
			layer.placeholderName = layer.attachmentName;
		else if (!startsWith(layer.attachmentName, skinName + "/")) { // Should never happen.
			error("Expected attachment name \"" + layer.attachmentName + "\" to start with skin name: " + skinName + "/");
			continue;
		} else
			layer.placeholderName = layer.attachmentName.substring(skinName.length + 1);

		layer.mesh = layer.findTagValue("mesh", true);

		layer.slotName = layer.findTagValue("slot") || name;
		var slot = get(slots, layer.slotName);
		if (!slot) {
			slotsCount++;
			set(slots, layer.slotName, slot = {
				bone: bone,
				attachment: layer.wasVisible ? layer.placeholderName : null,
				placeholders: {},
				attachments: false,
				layers: {}
			});
		} else if (!slot.attachment && layer.wasVisible)
			slot.attachment = layer.placeholderName;
		set(slot.layers, layer.attachmentName, layer);
		if (layer.blendMode == "linearDodge")
			slot.blend = "additive";
		else if (layer.blendMode == "multiply")
			slot.blend = "multiply";
		else if (layer.blendMode == "screen")
			slot.blend = "screen";

		var placeholders = get(slot.placeholders, skinName);
		if (!placeholders)
			set(slot.placeholders, skinName, placeholders = {});
		else {
			var existing = get(placeholders, layer.placeholderName);
			if (existing) { // Skin has duplicate placeholders.
				var key = layer.slotName + "|^`" + skinName;
				remove(skinDuplicates, key, existing);
				add(skinDuplicates, key, existing);
				add(skinDuplicates, key, layer);
			}
		}
		set(placeholders, layer.placeholderName, layer);

		var skinSlots = get(skins, skinName);
		if (!skinSlots) {
			set(skins, skinName, skinSlots = {});
			skinsCount++;
		}
		add(skinSlots, layer.slotName, layer);

		totalLayerCount++;
	}

	// Error if a skin has multiple skin placeholders with the same name.
	for (var key in skinDuplicates) {
		if (!skinDuplicates.hasOwnProperty(key)) continue;
		var layers = skinDuplicates[key];
		var message = "Multiple layers for the \"" + layers[0].skinName + "\" skin in the \"" + layers[0].slotName
			+ "\" slot have the same name \"" + layers[0].placeholderName + "\":\n";
		for (var i = 0, n = layers.length; i < n; i++)
			message += "\n" + layers[i].path();
		error(message + "\n\nRename or use the [ignore] tag for these layers.");
	}

	var slotDuplicates = {};
	for (var slotName in slots) {
		if (!slots.hasOwnProperty(slotName)) continue;
		var slot = slots[slotName];

		// Error if a source mesh isn't found in the same slot.
		var layers = slot.layers;
		for (var attachmentName in layers) {
			if (!layers.hasOwnProperty(attachmentName)) continue;
			var layer = layers[attachmentName];
			if (!layer.mesh) continue;
			if (layer.mesh === true) continue;
			var source = get(layers, layer.mesh);
			if (!source) {
				error("Source mesh \"" + layer.mesh + "\" not found in slot \"" + stripName(slotName) + "\":\n\n"
					+ layer.path() + "\n\nPrepend the skin name, if any. For example:\nskinName/" + layer.mesh);
				continue;
			}
			if (!source.mesh) {
				error("Layer \"" + source.path() + "\" is not a mesh:\n\n" + layer.path());
				continue;
			}
			layer.mesh = source;
		}

		// Error if a skin placeholder has the same name as a default skin attachment.
		var defaultPlaceholders = get(slot.placeholders, "default");
		if (!defaultPlaceholders) continue;
		for (var skinName in slot.placeholders) {
			if (!slot.placeholders.hasOwnProperty(skinName)) continue;
			var placeholders = slot.placeholders[skinName];
			if (stripName(skinName) == "default") continue;

			for (var placeholderName in placeholders) {
				if (!placeholders.hasOwnProperty(placeholderName)) continue;

				var existing = get(defaultPlaceholders, stripName(placeholderName));
				if (existing) {
					var layer = placeholders[placeholderName];
					remove(slotDuplicates, layer.slotName, existing);
					add(slotDuplicates, layer.slotName, existing);
					add(slotDuplicates, layer.slotName, layer);
				}
			}
		}
	}
	for (var slotName in slotDuplicates) {
		if (!slotDuplicates.hasOwnProperty(slotName)) continue;
		var layers = slotDuplicates[slotName];
		var message = "Multiple layers for the \"" + layers[0].slotName + "\" slot have the same name \"" + layers[0].placeholderName + "\":\n";
		for (var i = 0, n = layers.length; i < n; i++)
			message += "\n" + layers[i].path();
		error(message + "\n\nRename or use the [ignore] tag for these layers.");
	}

	var n = errors.length;
	if (n) {
		var first = errors[0];
		var file = null;
		if (n > 1) {
			try {
				var all = "";
				for (var i = 0; i < n; i++) {
					if (i > 0) all += "---\n";
					all += errors[i].replace(/\n\n/g, "\n") + "\n";
				}
				file = new File(jsonFile.parent + "/errors.txt");
				file.parent.create();
				file.encoding = "UTF-8";
				file.remove();
				file.open("w", "TEXT");
				file.lineFeed = "\n";
				file.write(all);
				file.close();
				if (n == 2)
					first += "\n\nSee errors.txt for 1 additional error.";
				else
					first += "\n\nSee errors.txt for " + (n - 1) + " additional errors.";
			} catch (e) {
				if (n == 2)
					first += "\n\nUnable to write 1 additional error to errors.text.\n"+e;
				else
					first += "\n\nUnable to write " + (n - 1) + " additional errors to errors.txt.\n"+e;
			}
		}
		alert(first);
		if (file) file.execute();
		return;
	}

	// Add a history item to prevent layer visibility from changing by restoreHistory.
	topLayer.name = "正在处理图层...";
	showProgress("正在处理图层...", totalLayerCount);

	// Output skins.
	var jsonSkins = "", layerCount = 0, writeImages = settings.imagesDir, tabs = legacyJson ? '\t\t' : '\t\t\t';
	for (var skinName in skins) {
		if (!skins.hasOwnProperty(skinName)) continue;
		var skinSlots = skins[skinName];
		skinName = stripName(skinName);

		var jsonSkin = "";
		for (var slotName in skinSlots) {
			if (!skinSlots.hasOwnProperty(slotName)) continue;
			var slot = slots[slotName];
			var bone = slot.bone;
			var skinLayers = skinSlots[slotName];
			slotName = stripName(slotName);

			var jsonSlot = "";
			for (var i = skinLayers.length - 1; i >= 0; i--) {
				layerCount++;
				var layer = skinLayers[i];
				layer.show();

				incrProgress(layer.name);
				if (cancel) return;

				var attachmentName = layer.attachmentName, attachmentPath = layer.attachmentPath, placeholderName = layer.placeholderName, mesh = layer.mesh;
				var scale = layer.scale, overlays = layer.overlays;

				var trim = layer.findTagValue("trim");
				if (trim != null)
					trim = trim != "false";
				else
					trim = settings.trimWhitespace;

				if (layer.isGroup) {
					layer.select();
					merge();
					layer = new Layer(layer.id, layer.parent, layer.selected);
				}
				layer.rasterizeStyles();

				for (var ii = 0, nn = overlays.length; ii < nn; ii++) {
					var overlay = overlays[ii];
					overlay.moveAbove(layer);
					overlay.setClippingMask(true);
					overlay.show();
				}

				var bounds = mesh && mesh != true ? mesh : layer;
				bounds.updateBounds();
				if (!bounds.width || !bounds.height) {
					layer.hide();
					continue;
				}
				slot.attachments = true;

				if (writeImages) storeHistory();

				var x, y, width, height, docHeightCropped;
				if (trim) {
					x = bounds.left;
					y = bounds.top;
					width = bounds.width;
					height = bounds.height;
					activeDocument.crop([x - xOffSet, y - yOffSet, bounds.right - xOffSet, bounds.bottom - yOffSet], 0, width, height);
					x *= settings.scale;
					y *= settings.scale;
					docHeightCropped = height;
				} else {
					x = 0;
					y = 0;
					width = docWidth;
					height = docHeightCropped = docHeight;
				}
				width = width * settings.scale + settings.padding * 2;
				height = height * settings.scale + settings.padding * 2;

				// Save image.
				if (writeImages) {
					scaleImage(settings.scale * scale);
					if (settings.padding > 0) activeDocument.resizeCanvas(width * scale, height * scale, AnchorPosition.MIDDLECENTER);

					var file = new File(imagesDir + attachmentPath + ".png");
					file.parent.create();
					savePNG(file);
					restoreHistory();
				}

				if (layerCount < totalLayerCount) layer.hide();

				var center = mesh ? 0 : 0.5;
				x += Math.round(width) * center - settings.padding;
				y = docHeightCropped - (y + Math.round(height) * center - settings.padding);
				width = Math.round(width * scale);
				height = Math.round(height * scale);

				// Make relative to the Photoshop document ruler origin.
				x -= xOffSet * settings.scale;
				y -= docHeightCropped - yOffSet * settings.scale;

				if (bone) { // Make relative to parent bone.
					x -= bone.x;
					y -= bone.y;
				}

				var json = "\t" + tabs + quote(placeholderName) + ': { ';
				if (attachmentName != placeholderName) json += '"name": ' + quote(attachmentName) + ', ';
				if (attachmentName != attachmentPath) json += '"path": ' + quote(attachmentPath) + ', ';
				if (mesh) {
					if (mesh === true)
						json += '"type": "mesh", ';
					else {
						json += '"type": "linkedmesh", "parent": "' + mesh.placeholderName + '", ';
						if (mesh.skinName) json += '"skin": "' + mesh.skinName + '", ';
					}
					json += '"width": ' + width + ', "height": ' + height + ', "vertices": [ ';
					json += (x + width) + ', ' + (y - height) + ', ';
					json += x + ', ' + (y - height) + ', ';
					json += x + ', ' + y + ', ';
					json += (x + width) + ', ' + y + ' ], "uvs": [ 1, 1, 0, 1, 0, 0, 1, 0 ], "triangles": [ 1, 2, 3, 1, 3, 0 ], "hull": 4, "edges": [ 0, 2, 2, 4, 4, 6, 0, 6 ]';
				} else {
					json += '"x": ' + x + ', "y": ' + y + ', "width": ' + width + ', "height": ' + height;
					if (scale != 1) json += ', "scaleX": ' + (1 / scale) + ', "scaleY": ' + (1 / scale);
				}
				json += ' },\n';
				jsonSlot += json;
			}
			if (jsonSlot) jsonSkin += tabs + quote(slotName) + ': {\n' + jsonSlot.substring(0, jsonSlot.length - 2) + '\n' + tabs + '\},\n';
		}
		if (jsonSkin) {
			if (legacyJson)
				jsonSkins += '\t"' + skinName + '": {\n' + jsonSkin.substring(0, jsonSkin.length - 2) + '\n\t},\n';
			else
				jsonSkins += '\t{\n\t\t"name": ' + quote(skinName) + ',\n\t\t"attachments": {\n' + jsonSkin.substring(0, jsonSkin.length - 2) + '\n\t\t}\n\t},\n';
		}
	}
	lastLayerName = null;

	activeDocument.close(SaveOptions.DONOTSAVECHANGES);

	// Output skeleton.
	var json = '{ "skeleton": { "images": "' + imagesDir + '" },\n';
	json += '"PhotoshopToSpine": { "scale": ' + settings.scale + ', "padding": ' + settings.padding + ', "trim": ' + settings.trimWhitespace + ' },\n';
	json += '"bones": [\n';

	// Output bones.
	function outputBone (bone) {
		var json = bone.parent ? ',\n' : '';
		json += '\t{ "name": ' + quote(bone.name);
		var x = bone.x, y = bone.y;
		if (bone.parent) {
			x -= bone.parent.x;
			y -= bone.parent.y;
			json += ', "parent": ' + quote(bone.parent.name);
		}
		if (x) json += ', "x": ' + x;
		if (y) json += ', "y": ' + y;
		json += ' }';
		for (var i = 0, n = bone.children.length; i < n; i++)
			json += outputBone(bone.children[i]);
		return json;
	}
	for (var boneName in bones) {
		if (cancel) return;
		if (!bones.hasOwnProperty(boneName)) continue;
		var bone = bones[boneName];
		if (!bone.parent) json += outputBone(bone);
	}
	json += '\n],\n"slots": [\n';

	// Output slots.
	var slotIndex = 0;
	for (var slotName in slots) {
		if (cancel) return;
		if (!slots.hasOwnProperty(slotName)) continue;
		var slot = slots[slotName];
		if (!slot.attachments) continue;
		slotName = stripName(slotName);
		json += '\t{ "name": ' + quote(slotName) + ', "bone": ' + quote(slot.bone ? slot.bone.name : "root");
		if (slot.attachment) json += ', "attachment": ' + quote(slot.attachment);
		if (slot.blend) json += ', "blend": ' + quote(slot.blend);
		json += ' }';
		slotIndex++;
		json += slotIndex < slotsCount ? ',\n' : '\n';
	}
	json += '],\n';

	if (jsonSkins) {
		if (legacyJson)
			json += '"skins": {\n' + jsonSkins.substring(0, jsonSkins.length - 2) + '\n},\n';
		else
			json += '"skins": [\n' + jsonSkins.substring(0, jsonSkins.length - 2) + '\n],\n';
	}

	json += '"animations": { "animation": {} }\n}';

	// Output JSON file.
	if (settings.writeJson && settings.jsonPath) {
		if (cancel) return;
		jsonFile.encoding = "UTF-8";
		jsonFile.remove();
		jsonFile.open("w", "TEXT");
		jsonFile.lineFeed = "\n";
		jsonFile.write(json);
		jsonFile.close();
	}
}

// Settings dialog:

function showSettingsDialog () {
	// 首先定义所有辅助函数
	function getBlendModeName(blendMode) {
		switch (blendMode) {
			case BlendMode.NORMAL: return "正常";
			case BlendMode.DISSOLVE: return "溶解";
			case BlendMode.DARKEN: return "变暗";
			case BlendMode.MULTIPLY: return "正片叠底";
			case BlendMode.COLORBURN: return "颜色加深";
			case BlendMode.LINEARBURN: return "线性加深";
			case BlendMode.LIGHTEN: return "变亮";
			case BlendMode.SCREEN: return "滤色";
			case BlendMode.COLORDODGE: return "颜色减淡";
			case BlendMode.LINEARDODGE: return "线性减淡";
			case BlendMode.OVERLAY: return "叠加";
			case BlendMode.SOFTLIGHT: return "柔光";
			case BlendMode.HARDLIGHT: return "强光";
			case BlendMode.VIVIDLIGHT: return "亮光";
			case BlendMode.LINEARLIGHT: return "线性光";
			case BlendMode.PINLIGHT: return "点光";
			case BlendMode.HARDMIX: return "实色混合";
			case BlendMode.DIFFERENCE: return "差值";
			case BlendMode.EXCLUSION: return "排除";
			case BlendMode.SUBTRACT: return "减去";
			case BlendMode.DIVIDE: return "划分";
			case BlendMode.HUE: return "色相";
			case BlendMode.SATURATION: return "饱和度";
			case BlendMode.COLOR: return "颜色";
			case BlendMode.LUMINOSITY: return "明度";
			default: return "未知模式";
		}
	}

	function hasLayerEffects(layer) {
		try {
			// 首先检查图层是否有效果
			if (!layer.layerEffects) return false;
			
			var effects = layer.layerEffects;
			
			// 调试输出
			$.writeln("图层名称: " + layer.name);
			$.writeln("图层效果属性:");
			for (var prop in effects) {
				$.writeln(prop + ": " + effects[prop]);
				// 如果是对象，进一步查看其属性
				if (typeof effects[prop] === 'object') {
					for (var subProp in effects[prop]) {
						$.writeln("  - " + subProp + ": " + effects[prop][subProp]);
					}
				}
			}
			
			// 检查所有可能的图层样式
			if (effects.frameFX && effects.frameFX.enabled) return true;      // 描边
			if (effects.dropShadow && effects.dropShadow.enabled) return true;        // 投影
			if (effects.innerShadow && effects.innerShadow.enabled) return true;      // 内阴影
			if (effects.outerGlow && effects.outerGlow.enabled) return true;         // 外发光
			if (effects.innerGlow && effects.innerGlow.enabled) return true;         // 内发光
			if (effects.bevelEmboss && effects.bevelEmboss.enabled) return true;     // 斜面和浮雕
			if (effects.chromeFX && effects.chromeFX.enabled) return true;          // 光泽
			if (effects.solidFill && effects.solidFill.enabled) return true;         // 纯色
			if (effects.gradientFill && effects.gradientFill.enabled) return true;   // 渐变
			if (effects.patternFill && effects.patternFill.enabled) return true;     // 图案
			if (effects.satin && effects.satin.enabled) return true;             // 光泽
			if (effects.colorOverlay && effects.colorOverlay.enabled) return true;    // 颜色叠加
			if (effects.gradientOverlay && effects.gradientOverlay.enabled) return true;   // 渐变叠加
			if (effects.patternOverlay && effects.patternOverlay.enabled) return true;    // 图案叠加

			// 如果没有任何效果返回 false
			return false;
		} catch(e) {
			// 如果出现错误，打印错误信息以便调试
			$.writeln("检查图层效果时出错: " + e);
			return false;
		}
	}

	function processBlendLayers(doc) {
		var layersProcessed = 0;
		for (var i = 0; i < doc.layers.length; i++) {
			processBlendLayer(doc.layers[i]);
		}
		return layersProcessed;

		function processBlendLayer(layer) {
			if (layer.typename === "ArtLayer") {
				try {
					// 使用字符串比较而不是枚举值
					if (layer.blendMode.toString() !== "BlendMode.NORMAL") {
						var blendModeName = getBlendModeName(layer.blendMode);
						// 保存原始混合模式名称
						var originalBlendMode = layer.blendMode;
						try {
							// 尝试设置为正常模式
							layer.blendMode = BlendMode.NORMAL;
							// 如果成功，则更新图层名称
							layer.name = blendModeName + "_" + layer.name;
							layersProcessed++;
						} catch(e) {
							// 如果设置失败，恢复原始混合模式
							layer.blendMode = originalBlendMode;
						}
					}
				} catch(e) {
					// 忽略无法处理的图层
				}
			} else if (layer.typename === "LayerSet") {
				// 递归处理组内的所有图层
				for (var i = 0; i < layer.layers.length; i++) {
					processBlendLayer(layer.layers[i]);
				}
			}
		}
	}

	function processStyleLayers(doc) {
		var layersProcessed = 0;
		for (var i = 0; i < doc.layers.length; i++) {
			processStyleLayer(doc.layers[i]);
		}
		return layersProcessed;

		function processStyleLayer(layer) {
			if (layer.typename === "ArtLayer") {
				if (layer.layerEffects && hasLayerEffects(layer)) {
					layer.name = "样式_" + layer.name;
					layersProcessed++;
				}
			} else if (layer.typename === "LayerSet") {
				var hasLayerStyle = false;
				for (var i = 0; i < layer.layers.length; i++) {
					if (layer.layers[i].typename === "ArtLayer" && 
						layer.layers[i].layerEffects && hasLayerEffects(layer.layers[i])) {
						hasLayerStyle = true;
						break;
					}
				}
				
				if (hasLayerStyle) {
					layer.name = "组样式_" + layer.name;
					layersProcessed++;
				}

				for (var i = 0; i < layer.layers.length; i++) {
					processStyleLayer(layer.layers[i]);
				}
			}
		}
	}

	function processEffectLayers(doc) {
		var layersProcessed = 0;
		for (var i = 0; i < doc.layers.length; i++) {
			processEffectLayer(doc.layers[i]);
		}
		return layersProcessed;

		function processEffectLayer(layer) {
			if (layer.typename === "ArtLayer") {
				if (hasAdjustmentLayer(layer)) {
					layer.name = "效果_" + layer.name;
					layersProcessed++;
				}
			} else if (layer.typename === "LayerSet") {
				for (var i = 0; i < layer.layers.length; i++) {
					processEffectLayer(layer.layers[i]);
				}
			}
		}
	}

	function processDuplicateLayers(doc) {
		var layersProcessed = 0;
		var nameCounts = {};
		for (var i = 0; i < doc.layers.length; i++) {
			processDuplicateLayer(doc.layers[i]);
		}
		return layersProcessed;

		function processDuplicateLayer(layer) {
			if (layer.typename === "ArtLayer") {
				var processedName = layer.name.replace(/\s+/g, '');
				if (nameCounts[processedName] == undefined) {
					nameCounts[processedName] = 0;
				} else {
					nameCounts[processedName]++;
					layer.name = processedName + "_" + nameCounts[processedName];
					layersProcessed++;
				}
			} else if (layer.typename === "LayerSet") {
				for (var i = 0; i < layer.layers.length; i++) {
					processDuplicateLayer(layer.layers[i]);
				}
			}
		}
	}

	// 然后创建对话框和UI元素
	var dialog = new Window("dialog", "PhotoshopToSpine v" + scriptVersion);
	dialog.alignChildren = "fill";

	try {
		dialog.add("image", undefined, new File(scriptDir() + "logo.png"));
	} catch (ignored) {}

	var settingsGroup = dialog.add("panel", undefined, "设置");
		settingsGroup.margins = [10,15,10,10];
		settingsGroup.alignChildren = "fill";
		var checkboxGroup = settingsGroup.add("group");
			checkboxGroup.alignChildren = ["left", ""];
			checkboxGroup.orientation = "row";
			group = checkboxGroup.add("group");
				group.orientation = "column";
				group.alignChildren = ["left", ""];
				var ignoreHiddenLayersCheckbox = group.add("checkbox", undefined, " 忽略隐藏图层");
				ignoreHiddenLayersCheckbox.value = settings.ignoreHiddenLayers;
				ignoreHiddenLayersCheckbox.helpTip = "选中后，将不会处理隐藏的图层，可以提高处理速度";
				var ignoreBackgroundCheckbox = group.add("checkbox", undefined, " 忽略背景图层");
				ignoreBackgroundCheckbox.value = settings.ignoreBackground;
				ignoreBackgroundCheckbox.helpTip = "选中后，将不会处理背景图层，通常用于避免导出不需要的底图";
				var trimWhitespaceCheckbox = group.add("checkbox", undefined, " 修剪空白区域");
				trimWhitespaceCheckbox.value = settings.trimWhitespace;
			group = checkboxGroup.add("group");
				group.orientation = "column";
				group.alignChildren = ["left", ""];
				group.alignment = ["", "top"];
				var writeJsonCheckbox = group.add("checkbox", undefined, " 生成Spine JSON");
				writeJsonCheckbox.value = settings.writeJson;
				var writeTemplateCheckbox = group.add("checkbox", undefined, " 生成模板图像");
				writeTemplateCheckbox.value = settings.writeTemplate;
				var selectionOnlyCheckbox = group.add("checkbox", undefined, " 仅处理选中图层");
				selectionOnlyCheckbox.value = settings.selectionOnly;
		var scaleText, paddingText, scaleSlider, paddingSlider;
		if (!cs2) {
			var slidersGroup = settingsGroup.add("group");
				group = slidersGroup.add("group");
					group.orientation = "column";
					group.alignChildren = ["right", ""];
					group.add("statictext", undefined, "缩放:");
					group.add("statictext", undefined, "出血像素:");
				group = slidersGroup.add("group");
					group.orientation = "column";
					scaleText = group.add("edittext", undefined, settings.scale * 100);
					scaleText.characters = 4;
					paddingText = group.add("edittext", undefined, settings.padding);
					paddingText.characters = 4;
				group = slidersGroup.add("group");
					group.orientation = "column";
					group.add("statictext", undefined, "%");
					group.add("statictext", undefined, "px");
				group = slidersGroup.add("group");
					group.orientation = "column";
					group.alignChildren = ["fill", ""];
					group.alignment = ["fill", ""];
					scaleSlider = group.add("slider", undefined, settings.scale * 100, 1, 400);
					paddingSlider = group.add("slider", undefined, settings.padding, 0, 4);
		} else {
			group = settingsGroup.add("group");
				group.add("statictext", undefined, "缩放:");
				scaleText = group.add("edittext", undefined, settings.scale * 100);
				scaleText.preferredSize.width = 50;
			scaleSlider = settingsGroup.add("slider", undefined, settings.scale * 100, 1, 400);
			group = settingsGroup.add("group");
				group.add("statictext", undefined, "出血像素:");
				paddingText = group.add("edittext", undefined, settings.padding);
				paddingText.preferredSize.width = 50;
			paddingSlider = settingsGroup.add("slider", undefined, settings.padding, 0, 4);
		}

	if (cs2) {
		ignoreHiddenLayersCheckbox.preferredSize.width = 150;
		ignoreBackgroundCheckbox.preferredSize.width = 150;
		trimWhitespaceCheckbox.preferredSize.width = 150;
		writeJsonCheckbox.preferredSize.width = 150;
		writeTemplateCheckbox.preferredSize.width = 150;
		selectionOnlyCheckbox.preferredSize.width = 150;
	}

	var outputPathGroup = dialog.add("panel", undefined, "输出路径");
		outputPathGroup.alignChildren = ["fill", ""];
		outputPathGroup.margins = [10,15,10,10];
		var imagesDirText, imagesDirPreview, jsonPathText, jsonPathPreview;
		if (!cs2) {
			var textGroup = outputPathGroup.add("group");
			textGroup.orientation = "column";
			textGroup.alignChildren = ["fill", ""];
			group = textGroup.add("group");
				group.add("statictext", undefined, "图像位置:");
				imagesDirText = group.add("edittext", undefined, settings.imagesDir);
				imagesDirText.alignment = ["fill", ""];
			imagesDirPreview = textGroup.add("statictext", undefined, "");
			imagesDirPreview.maximumSize.width = 260;
			group = textGroup.add("group");
				var jsonLabel = group.add("statictext", undefined, "JSON位置:");
				jsonLabel.justify = "right";
				jsonLabel.minimumSize.width = 41;
				jsonPathText = group.add("edittext", undefined, settings.jsonPath);
				jsonPathText.alignment = ["fill", ""];
			jsonPathPreview = textGroup.add("statictext", undefined, "");
			jsonPathPreview.maximumSize.width = 260;
		} else {
			outputPathGroup.add("statictext", undefined, "图像位置:");
			imagesDirText = outputPathGroup.add("edittext", undefined, settings.imagesDir);
			imagesDirText.alignment = "fill";
			outputPathGroup.add("statictext", undefined, "JSON位置:");
			jsonPathText = outputPathGroup.add("edittext", undefined, settings.jsonPath);
			jsonPathText.alignment = "fill";
		}

	// 修改检测面板部分
	var detectionGroup = dialog.add("panel", undefined, "检测");
	detectionGroup.alignChildren = ["fill", ""];
	detectionGroup.margins = [10, 15, 10, 10];
	detectionGroup.helpTip = "提供图层检测和自动处理功能";

	// 创建一个水平排列的组来放置复选框
	var checkboxGroup = detectionGroup.add("group");
	checkboxGroup.orientation = "row";
	checkboxGroup.alignChildren = ["left", "center"];
	checkboxGroup.spacing = 20; // 设置两个复选框之间的间距

	// 创建混合模式检测复选框
	var blendDetectionCheckbox = checkboxGroup.add("checkbox", undefined, "混合模式检测");
	blendDetectionCheckbox.value = true;
	blendDetectionCheckbox.helpTip = "检测并处理特殊混合模式的图层\n右键点击可以单独执行混合模式检测";

	// 创建重名图层检测复选框
	var duplicateDetectionCheckbox = checkboxGroup.add("checkbox", undefined, "重名图层检测");
	duplicateDetectionCheckbox.value = true;
	duplicateDetectionCheckbox.helpTip = "检测并处理重名图层\n右键点击可以单独执行重名检测";

	// 添加"开始检测"按钮
	var startDetectionButton = detectionGroup.add("button", undefined, "开始检测");
	startDetectionButton.helpTip = "执行所有选中的检测项";

	// 为混合模式检测复选框添加右键菜单事件
	blendDetectionCheckbox.addEventListener('mousedown', function(ev) {
		if (ev.button == 2) { // 右键点击
			try {
				if (app.documents.length > 0) {
					var doc = app.activeDocument;
					var blendProcessed = processBlendLayers(doc);
					if (blendProcessed > 0) {
						alert("混合模式检测完成！处理了 " + blendProcessed + " 个图层。");
					}
				} else {
					alert("没有打开的文档！");
				}
			} catch(e) {
				alert("处理过程中发生错误：" + e.message);
			}
		}
	});

	// 为重名图层检测复选框添加右键菜单事件
	duplicateDetectionCheckbox.addEventListener('mousedown', function(ev) {
		if (ev.button == 2) { // 右键点击
			try {
				if (app.documents.length > 0) {
					var doc = app.activeDocument;
					var duplicateProcessed = processDuplicateLayers(doc);
					if (duplicateProcessed > 0) {
						alert("重名图层检测完成！处理了 " + duplicateProcessed + " 个图层。");
					}
				} else {
					alert("没有打开的文档！");
				}
			} catch(e) {
				alert("处理过程中发生错误：" + e.message);
			}
		}
	});

	// 添加按钮组
	var buttonGroup = dialog.add("group");
		var helpButton;
		if (!cs2) helpButton = buttonGroup.add("button", undefined, "帮助");
		group = buttonGroup.add("group");
			group.alignment = ["fill", ""];
			group.alignChildren = ["right", ""];
			var runButton = group.add("button", undefined, "确定");
			var cancelButton = group.add("button", undefined, "取消");

	// 开始检测按钮点击事件
	startDetectionButton.onClick = function() {
		try {
			if (app.documents.length > 0) {
				var doc = app.activeDocument;
				var totalProcessed = 0;
				
				if (blendDetectionCheckbox.value) {
					var blendProcessed = processBlendLayers(doc);
					totalProcessed += blendProcessed;
				}
				
				if (duplicateDetectionCheckbox.value) {
					var duplicateProcessed = processDuplicateLayers(doc);
						totalProcessed += duplicateProcessed;
				}
				
				if (totalProcessed > 0) {
					alert("检测完成！共处理 " + totalProcessed + " 个图层。");
				} else {
					alert("未发现需要处理的图层。");
				}
			} else {
				alert("没有打开的文档！");
			}
		} catch(e) {
			alert("处理过程中发生错误：" + e.message);
		}
	};

	// 处理混合模式的函数
	function processBlendLayers(doc) {
		var layersProcessed = 0;
		var blendLayers = []; // 存储使用特殊混合模式的图层
		
		// 先收集所有使用特殊混合模式的图层
		function collectBlendLayers(layer) {
			if (layer.typename === "ArtLayer") {
				try {
					if (layer.blendMode.toString() !== "BlendMode.NORMAL") {
						blendLayers.push({
							layer: layer,
							name: layer.name,
							blendMode: layer.blendMode
						});
					}
				} catch(e) {}
			} else if (layer.typename === "LayerSet") {
				for (var i = 0; i < layer.layers.length; i++) {
					collectBlendLayers(layer.layers[i]);
				}
			}
		}
		
		// 收集图层
		for (var i = 0; i < doc.layers.length; i++) {
			collectBlendLayers(doc.layers[i]);
		}
		
		// 如果找到使用特殊混合模式的图层
		if (blendLayers.length > 0) {
			var message = "检测到以下图层使用了特殊混合模式：\n\n";
			// 替换 forEach
			for (var i = 0; i < blendLayers.length; i++) {
				var item = blendLayers[i];
				message += "- " + item.name + "（" + getBlendModeName(item.blendMode) + "）\n";
			}
			message += "\n是否将这些图层转换为正常模式，并在名称前添加原混合模式标识？";
			
			if (confirm(message)) {
				// 替换 forEach
				for (var i = 0; i < blendLayers.length; i++) {
					var item = blendLayers[i];
					try {
						var blendModeName = getBlendModeName(item.blendMode);
						item.layer.blendMode = BlendMode.NORMAL;
						item.layer.name = blendModeName + "_" + item.layer.name;
						layersProcessed++;
					} catch(e) {}
				}
			}
		} else {
			alert("未检测到使用特殊混合模式的图层。");
		}
		
		return layersProcessed;
	}

	// 修改重名图层检测函数
	function processDuplicateLayers(doc) {
		var layersProcessed = 0;
		var nameCounts = {};
		var duplicateLayers = []; // 存储重名图层
		
		// 先收集所有重名图层
		function collectDuplicateLayers(layer) {
			if (layer.typename === "ArtLayer") {
				var processedName = layer.name.replace(/\s+/g, '');
				if (nameCounts[processedName] == undefined) {
					nameCounts[processedName] = [{
						layer: layer,
						name: layer.name
					}];
				} else {
					nameCounts[processedName].push({
						layer: layer,
						name: layer.name
					});
				}
			} else if (layer.typename === "LayerSet") {
				for (var i = 0; i < layer.layers.length; i++) {
					collectDuplicateLayers(layer.layers[i]);
				}
			}
		}
		
		// 收集图层
		for (var i = 0; i < doc.layers.length; i++) {
			collectDuplicateLayers(doc.layers[i]);
		}
		
		// 找出重名的图层
		for (var name in nameCounts) {
			if (nameCounts[name].length > 1) {
				duplicateLayers.push({
					name: name,
					layers: nameCounts[name]
				});
			}
		}
		
		// 如果找到重名图层
		if (duplicateLayers.length > 0) {
			var message = "检测到以下重名图层：\n\n";
			// 替换 forEach
			for (var i = 0; i < duplicateLayers.length; i++) {
				var group = duplicateLayers[i];
				message += "名称 \"" + group.name + "\" 有 " + group.layers.length + " 个图层：\n";
				// 替换内层 forEach
				for (var j = 0; j < group.layers.length; j++) {
					var item = group.layers[j];
					message += "  - " + item.name + "\n";
				}
				message += "\n";
			}
			message += "是否为重名图层添加编号后缀？";
			
			if (confirm(message)) {
				// 替换 forEach
				for (var i = 0; i < duplicateLayers.length; i++) {
					var group = duplicateLayers[i];
					// 替换内层 forEach
					for (var j = 0; j < group.layers.length; j++) {
						var item = group.layers[j];
						if (j > 0) { // 第一个保持原样
							item.layer.name = item.name + "_" + j;
							layersProcessed++;
						}
					}
				}
			}
		} else {
			alert("未检测到重名图层。");
		}
		
		return layersProcessed;
	}

	// ... 其他现有代码 ...

	// Tooltips.
	writeTemplateCheckbox.helpTip = "选中后，将为当前可见图层生成PNG图像。";
	writeJsonCheckbox.helpTip = "选中后，将生成Spine JSON文件。";
	trimWhitespaceCheckbox.helpTip = "选中后，将自动裁剪图层周围的空白区域，使导出的图片更紧凑。";
	selectionOnlyCheckbox.helpTip = "选中后，只处理选中的图层。";
	scaleSlider.helpTip = "缩放PNG文件。当在Photoshop中使用比Spine中更高分辨率的图像时非常有用。";
	paddingSlider.helpTip = "图像边缘周围的空白像素。可以避免图像边缘不透明像素产生混叠伪影。";
	imagesDirText.helpTip = "写入PNG的文件夹。以\"./\"开头表示相对于PSD文件的位置。留空则不导出PNG。";
	jsonPathText.helpTip = "如果以\".json\"结尾则为输出JSON文件，否则为写入JSON文件的文件夹。以\"./\"开头表示相对于PSD文件的位置。留空则不生成JSON文件。";

	// Events.
	scaleText.onChanging = function () { scaleSlider.value = scaleText.text; };
	scaleSlider.onChanging = function () { scaleText.text = Math.round(scaleSlider.value); };
	paddingText.onChanging = function () { paddingSlider.value = paddingText.text; };
	paddingSlider.onChanging = function () { paddingText.text = Math.round(paddingSlider.value); };
	cancelButton.onClick = function () {
		cancel = true;
		dialog.close();
		return;
	};
	if (!cs2) helpButton.onClick = showHelpDialog;
	jsonPathText.onChanging = function () {
		var text = jsonPathText.text ? jsonPath(jsonPathText.text) : "<不输出JSON>";
		if (!cs2) {
			jsonPathPreview.text = text;
			jsonPathPreview.helpTip = text;
		} else
			jsonPathText.helpTip = text;
	};
	imagesDirText.onChanging = function () {
		var text = imagesDirText.text ? absolutePath(imagesDirText.text) : "<不输出图像>";
		if (!cs2) {
			imagesDirPreview.text = text;
			imagesDirPreview.helpTip = text;
		} else
			imagesDirText.helpTip = text;
	};

	// Run now.
	jsonPathText.onChanging();
	imagesDirText.onChanging();

	function updateSettings () {
		settings.ignoreHiddenLayers = ignoreHiddenLayersCheckbox.value;
		settings.ignoreBackground = ignoreBackgroundCheckbox.value;
		settings.writeTemplate = writeTemplateCheckbox.value;
		settings.writeJson = writeJsonCheckbox.value;
		settings.trimWhitespace = trimWhitespaceCheckbox.value;
		settings.selectionOnly = selectionOnlyCheckbox.value;

		var scaleValue = parseFloat(scaleText.text);
		if (scaleValue > 0 && scaleValue <= 400) settings.scale = scaleValue / 100;

		settings.imagesDir = imagesDirText.text;
		settings.jsonPath = jsonPathText.text;

		var paddingValue = parseInt(paddingText.text);
		if (paddingValue >= 0) settings.padding = paddingValue;
	}

	runButton.onClick = function () {
		if (scaleText.text <= 0 || scaleText.text > 400) {
			alert("缩放比例必须大于0且小于等于400。");
			return;
		}
		if (paddingText.text < 0) {
			alert("出血像素必须大于等于0。");
			return;
		}

		updateSettings();
		saveSettings();

		ignoreHiddenLayersCheckbox.enabled = false;
		ignoreBackgroundCheckbox.enabled = false;
		writeTemplateCheckbox.enabled = false;
		writeJsonCheckbox.enabled = false;
		trimWhitespaceCheckbox.enabled = false;
		selectionOnlyCheckbox.enabled = false;
		scaleText.enabled = false;
		scaleSlider.enabled = false;
		paddingText.enabled = false;
		paddingSlider.enabled = false;
		imagesDirText.enabled = false;
		jsonPathText.enabled = false;
		if (!cs2) helpButton.enabled = false;
		runButton.enabled = false;
		cancelButton.enabled = false;

		var rulerUnits = app.preferences.rulerUnits;
		app.preferences.rulerUnits = Units.PIXELS;
		try {
			//var start = new Date().getTime();
			run();
			//alert((new Date().getTime() - start) / 1000 + "s");
		} catch (e) {
			if (e.message == "User cancelled the operation") return;
			var layerMessage = lastLayerName ? "[图层 " + lastLayerName + "] " : "";
			alert("发生意外错误:\n\n" + layerMessage + "[行: " + e.line + "] " + e.message
				+ "\n\n要调试，请使用Adobe ExtendScript运行PhotoshopToSpine脚本，并取消选中\"Debug > Do not break on guarded exceptions\"。\n\nv" + scriptVersion);
			debugger;
		} finally {
			if (activeDocument != originalDoc) activeDocument.close(SaveOptions.DONOTSAVECHANGES);
			app.preferences.rulerUnits = rulerUnits;
			if (progress && progress.dialog) progress.dialog.close();
			dialog.close();
		}
	};

	dialog.center();
	dialog.show();
}

function loadSettings () {
	var options;
	try {
		options = app.getCustomOptions("PhotoshopToSpine");
	} catch (ignored) {}

	settings = {};
	for (var key in defaultSettings) {
		if (!defaultSettings.hasOwnProperty(key)) continue;
		var typeID = sID(key);
		if (options && options.hasKey(typeID))
			settings[key] = options["get" + getOptionType(defaultSettings[key])](typeID);
		else
			settings[key] = defaultSettings[key];
	}
}

function saveSettings () {
	if (cs2) return; // No putCustomOptions.
	var desc = new ActionDescriptor();
	for (var key in defaultSettings) {
		if (!defaultSettings.hasOwnProperty(key)) continue;
		desc["put" + getOptionType(defaultSettings[key])](sID(key), settings[key]);
	}
	app.putCustomOptions("PhotoshopToSpine", desc, true);
}

function getOptionType (value) {
	switch (typeof(value)) {
	case "boolean": return "Boolean";
	case "string": return "String";
	case "number": return "Double";
	};
	throw new Error("Invalid default setting: " + value);
}

// Help dialog.

function showHelpDialog () {
	var dialog = new Window("dialog", "PhotoshopToSpine - 帮助");
	dialog.alignChildren = ["fill", ""];
	dialog.orientation = "column";
	dialog.alignment = ["", "top"];
	
	var helpText = dialog.add("statictext", undefined, ""
		+ "本脚本将图层导出为图像文件，并创建JSON文件，使图像在Spine中保持与Photoshop中相同的位置和绘制顺序。\n"
		+ "\n"
		+ "Photoshop中的标尺原点对应Spine中的坐标0,0。\n"
		+ "\n"
		+ "方括号中的标签可以在图层和组名称中的任何位置使用，以自定义输出。如果省略\":名称\"，则使用图层或组名称。\n"
		+ "\n"
		+ "组和图层名称：\n"
		+ "•  [bone]或[bone:名称]  图层、插槽和骨骼放置在骨骼下。骨骼创建在可见图层的中心。骨骼组可以嵌套。\n"
		+ "•  [slot]或[slot:名称]  图层放置在插槽中。\n"
		+ "•  [skin]或[skin:名称]  图层放置在皮肤中。皮肤图层图像输出到皮肤的子文件夹中。\n"
		+ "•  [scale:数字]  图层被缩放。它们的附件反向缩放，因此在Spine中显示相同大小。\n"
		+ "•  [folder]或[folder:名称]  图层图像输出到子文件夹中。文件夹组可以嵌套。\n"
		+ "•  [overlay]  此图层用作下方所有图层的剪切蒙版。\n"
		+ "•  [trim]或[trim:false]  强制此图层修剪空白区域或不修剪。\n"
		+ "•  [mesh]或[mesh:名称]  图层是网格，或者当指定名称时，是链接网格。\n"
		+ "•  [ignore]  图层、组和任何子组都不会输出。\n"
		+ "\n"
		+ "组名称：\n"
		+ "•  [merge]  组中的图层合并并输出单个图像。\n"
		+ "•  [name:模式]  为组中的图层名称添加前缀或后缀。模式必须包含星号(*)。\n"
		+ "\n"
		+ "图层名称：\n"
		+ "•  图层名称用作附件或皮肤占位符名称，相对于任何父[skin]或[folder]组。可以包含/表示子文件夹。\n"
		+ "•  [path:名称]  指定图像文件名，如果需要与附件名称不同。可以在带有[merge]的组上使用。\n"
		+ "\n"
		+ "如果图层名称、文件夹名称或路径名称以/开头，则父图层不会影响名称。\n"
		+ "\n"
		+ "新增功能：\n"
		+ "1. 混合模式检测\n"
		+ "   - 检测使用了特殊混合模式的图层\n" 
		+ "   - 可以将其转换为正常模式并在名称前添加原混合模式标识\n"
		+ "   - 右键点击\"混合模式检测\"文本可以单独执行此功能\n"
		+ "2. 重名图层检测\n"
		+ "   - 检测文档中的重名图层\n"
		+ "   - 可以自动为重复的图层名称添加编号\n"
		+ "   - 右键点击\"重名图层检测\"文本可以单独执行此功能\n"
		+ "\n"
		+ "使用技巧：\n"
		+ "- 勾选需要的检测项，点击\"开始检测\"执行所有选中的检测\n"
		+ "- 右键点击检测项文本可以快速执行单个检测\n"
		+ "- 检测前建议先保存文档，以便需要时可以撤销更改"
	, {multiline: true});
	helpText.preferredSize.width = 325;
	
	var closeButton = dialog.add("button", undefined, "关闭");
	closeButton.alignment = ["center", ""];

	closeButton.onClick = function () {
		dialog.close();
	};
	
	dialog.center();
	dialog.show();
}

// Progress dialog:

function showProgress (title, total) {
	title = title ? "PhotoshopToSpine - " + title : "PhotoshopToSpine";
	if (!progress) {
		var dialog = new Window("palette", title);
		dialog.alignChildren = "fill";
		dialog.orientation = "column";

		var message = dialog.add("statictext", undefined, "初始化中...");

		var group = dialog.add("group");
			var bar = group.add("progressbar");
			bar.preferredSize = [300, 16];
			bar.maxvalue = total;
			bar.value = 1;
			var cancelButton = group.add("button", undefined, "取消");

		cancelButton.onClick = function () {
			cancel = true;
			cancelButton.enabled = false;
			return;
		};

		dialog.center();
		dialog.show();
		dialog.active = true;

		progress = {
			dialog: dialog,
			bar: bar,
			message: message
		};
	} else {
		progress.dialog.text = title;
		progress.bar.maxvalue = total;
	}
	progress.count = 0;
	progress.total = total;
	progress.updateTime = 0;
	var reset = $.hiresTimer;
}

function incrProgress (layerName) {
	lastLayerName = trim(layerName);
	progress.count++;
	if (progress.count != 1 && progress.count < progress.total) {
		progress.updateTime += $.hiresTimer;
		if (progress.updateTime < 500000) return;
		progress.updateTime = 0;
	}
	progress.bar.value = progress.count;
	progress.message.text = progress.count + " / "+ progress.total + ": " + lastLayerName;
	if (!progress.dialog.active) progress.dialog.active = true;
}

// PhotoshopToSpine utility:

function initializeLayers (context, selectedLayers, parent, parentLayers) {
	while (context.index >= context.first) {
		if (cancel) return -1;

		var id = getLayerID(context.index--);

		var selected = parent && parent.selected;
		if (selectedLayers && !selected) {
			for (var i = 0, n = selectedLayers.length; i < n; i++) {
				if (selectedLayers[i] === id) {
					selected = true;
					break;
				}
			}
		}

		var layer = new Layer(id, parent, selected);
		if (layer.isGroupEnd) break;
		context.total++;
		parentLayers.push(layer);
		if (layer.isGroup) initializeLayers(context, selectedLayers, layer, layer.layers);
	}
}

function collectLayers (parentLayers, collect, overlays) {
	outer:
	for (var i = 0, n = parentLayers.length; i < n; i++) {
		if (cancel) return;
		var layer = parentLayers[i];
		incrProgress(layer.name);

		if (settings.selectionOnly && !layer.selected) {
			var needsMerge = layer.isGroup && (layer.findTagLayer("merge") || layer.findTagLayer("overlay"));
			if (!needsMerge && layer.layers && layer.layers.length > 0)
				collectLayers(layer.layers, collect, overlays);
			else
				layer.hide();
			continue;
		}

		if (settings.ignoreHiddenLayers && !layer.visible) continue;
		if (settings.ignoreBackground && layer.background) {
			layer.hide();
			continue;
		}
		if (layer.findTagLayer("ignore")) {
			layer.hide();
			continue;
		}
		if (layer.adjustment || layer.clipping) continue;
		if (!layer.isGroup && !layer.isNormal()) {
			layer.rasterize(); // In case rasterizeAll failed.
			if (!layer.isNormal()) {
				layer.hide();
				continue;
			}
		}

		// Ensure tags are valid.
		var re = /\[([^\]]+)\]/g;
		while (true) {
			var matches = re.exec(layer.name);
			if (!matches) break;
			var tag = matches[1];
			if (layer.isGroup) {
				if (!isValidGroupTag(tag)) {
					var message = "Invalid group name:\n\n" + layer.name;
					if (isValidLayerTag(tag))
						message += "\n\nThe [" + tag + "] tag is only valid for layers, not for groups.";
					else
						message += "\n\nThe [" + tag + "] tag is not a valid tag.";
					error(message);
					continue outer;
				}
			} else if (tag != "merge" && !isValidLayerTag(tag)) { // Allow merge, the user may have merged manually to save time.
				var message = "Invalid layer name:\n\n" + layer.name;
				if (isValidGroupTag(tag))
					message += "\n\nThe [" + tag + "] tag is only valid for groups, not for layers.";
				else
					message += "\n\nThe [" + tag + "] tag is not a valid tag.";
				error(message);
				continue outer;
			}
		}

		if (layer.findTagLayer("overlay")) {
			if (!layer.visible) continue;
			if (layer.isGroup) {
				layer.select();
				merge();
				layer = new Layer(layer.id, layer.parent, layer.selected);
			}
			layer.setLocked(false);
			layer.hide();
			overlays.push(layer);
			continue;
		}

		layer.wasVisible = layer.visible;
		layer.show();
		layer.setLocked(false);

		if (layer.isGroup && layer.findTagLayer("merge")) {
			collectGroupMerge(layer);
			if (!layer.layers || layer.layers.length == 0) continue;
		} else if (layer.layers && layer.layers.length > 0) {
			collectLayers(layer.layers, collect, overlays);
			continue;
		} else if (layer.isGroup)
			continue;

		layer.overlays = overlays.slice();
		layer.hide();
		collect.push(layer);
	}
}

function collectGroupMerge (parent) {
	var parentLayers = parent.layers;
	if (!parentLayers) return;
	for (var i = parentLayers.length - 1; i >= 0; i--) {
		var layer = parentLayers[i];
		if (settings.ignoreHiddenLayers && !layer.visible) continue;
		if (layer.findTagLayer("ignore")) {
			layer.hide();
			continue;
		}
		collectGroupMerge(layer);
	}
}

function isValidGroupTag (tag) {
	if (startsWith(tag, "name:")) return true;
	return tag == "merge" || isValidLayerTag(tag);
}

function isValidLayerTag (tag) {
	switch (tag) {
	case "bone":
	case "slot":
	case "skin":
	case "folder":
	case "ignore":
	case "overlay":
	case "trim":
	case "mesh":
		return true;
	}
	if (startsWith(tag, "bone:")) return true;
	if (startsWith(tag, "slot:")) return true;
	if (startsWith(tag, "skin:")) return true;
	if (startsWith(tag, "folder:")) return true;
	if (startsWith(tag, "path:")) return true;
	if (startsWith(tag, "scale:")) return true;
	if (startsWith(tag, "trim:")) return true;
	if (startsWith(tag, "mesh:")) return true;
	return false;
}

function stripTags (name) {
	return trim(name.replace(/\[[^\]]+\]/g, ""));
}

function jsonPath (jsonPath) {
	if (endsWith(jsonPath, ".json")) {
		var index = forwardSlashes(jsonPath).lastIndexOf("/");
		if (index != -1) return absolutePath(jsonPath.slice(0, index + 1)) + jsonPath.slice(index + 1);
		return absolutePath("./") + jsonPath;
	} 
	var name = decodeURI(originalDoc.name);
	return absolutePath(jsonPath) + name.substring(0, name.indexOf(".")) + ".json";
}

function error (message) {
	errors.push(message);
}

// Photoshop utility:

function get (object, name) {
	return object["_" + name];
}
function set (object, name, value) {
	object["_" + name] = value;
}
function add (object, name, value) {
	var array = object["_" + name];
	if (!array) object["_" + name] = array = [];
	array[array.length] = value;
	return array;
}
function remove (object, name, value) {
	var array = object["_" + name];
	if (!array) return;
	for (var i = 0, n = array.length; i < n; i++) {
		if (array[i] == value) {
			array.splice(i, 1);
			return;
		}
	}
}
function stripName (name) {
	return name.substring(1);
}

function rulerOrigin (axis) {
	var key = cID("Rlr" + axis);
	var ref = new ActionReference();
	ref.putProperty(cID("Prpr"), key);
	ref.putEnumerated(cID("Dcmn"), cID("Ordn"), cID("Trgt")); 
	return executeActionGet(ref).getInteger(key) >> 16;
}

// Seems to not be available when the document has >= 500 layers.
function rasterizeAll () {
	try {
		executeAction(sID("rasterizeAll"), undefined, DialogModes.NO);
	} catch (ignored) {}
}

// Layer must be selected.
function newLayerBelow (name) {
	var ref = new ActionReference();
	ref.putClass(cID("Lyr "));
	var desc2 = new ActionDescriptor();
	desc2.putString(cID("Nm  "), name);
	var desc1 = new ActionDescriptor();
	desc1.putReference(cID("null"), ref);
	desc1.putBoolean(sID("below"), true);
	desc1.putObject(cID("Usng"), cID("Lyr "), desc2);
	executeAction(cID("Mk  "), desc1, DialogModes.NO);
}

// Layer must be selected.
function merge () {
	executeAction(cID("Mrg2"), undefined, DialogModes.NO);
}

// Layer must be selected.
function channelBounds (name) {
	try {
		var ref1 = new ActionReference();
		ref1.putProperty(sID("channel"), sID("selection"));
		var ref2 = new ActionReference();
		ref2.putEnumerated(sID("channel"), sID("channel"), sID(name));
		var desc = new ActionDescriptor();
		desc.putReference(sID("null"), ref1);
		desc.putReference(sID("to"), ref2);
		executeAction(sID("set"), desc, DialogModes.NO);
		return activeDocument.selection.bounds;
	} catch (ignored) {}
	return null;
}

function scaleImage (scale) {
	if (scale == 1) return;
	var imageSize = activeDocument.width.as("px") * scale;
	activeDocument.resizeImage(UnitValue(imageSize, "px"), null, null, ResampleMethod.BICUBICAUTOMATIC);
}

var history;
function storeHistory () {
	history = activeDocument.activeHistoryState;
}
function restoreHistory () {
	activeDocument.activeHistoryState = history;
}

function scriptDir () {
	var file;
	if (!cs2)
		file = $.fileName;
	else {
		try {
			var error = THROW_ERROR; // Force error which provides the script file name.
		} catch (e) {
			file = e.fileName;
		}
	}
	return new File(file).parent + "/";
}

function absolutePath (path) {
	path = forwardSlashes(trim(path));
	if (path.length == 0) return forwardSlashes(decodeURI(activeDocument.path)) + "/"; // PSD folder.
	if (/^(\/|~|[A-Za-z]:)/.test(path)) return forwardSlashes(decodeURI(new File(path).fsName)) + "/"; // Absolute.
	if (startsWith(path, "./")) path = path.substring(2);
	return forwardSlashes(decodeURI(new File(activeDocument.path + "/" + path).fsName)) + "/"; // Relative to PSD folder.
}

function bgColor (control, r, g, b) {
	control.graphics.backgroundColor = control.graphics.newBrush(control.graphics.BrushType.SOLID_COLOR, [r, g, b]);
}

function deselectLayers () {
	var ref = new ActionReference();
	ref.putEnumerated(cID("Lyr "), cID("Ordn"), cID("Trgt"));
	var desc = new ActionDescriptor();
	desc.putReference(cID("null"), ref);
	try {
		executeAction(sID("selectNoLayers"), desc, DialogModes.NO);
	} catch (ignored) {} // Fails if only background layer.
}

function convertToRGB () {
	var desc = new ActionDescriptor();
	desc.putClass(cID("T   "), cID("RGBM"));
	desc.putBoolean(cID("Mrge"), false);
	desc.putBoolean(cID("Rstr"), true);
	executeAction(cID("CnvM"), desc, DialogModes.NO);
}

function deleteDocumentAncestorsMetadata () {
	if (ExternalObject.AdobeXMPScript == undefined) ExternalObject.AdobeXMPScript = new ExternalObject("lib:AdobeXMPScript");
	app.activeDocument.xmpMetadata.rawData = new XMPMeta().serialize();
}

function savePNG (file) {
	// SaveForWeb changes spaces to dash. Also some users report it writes HTML.
	//var options = new ExportOptionsSaveForWeb();
	//options.format = SaveDocumentType.PNG;
	//options.PNG8 = false;
	//options.transparency = true;
	//options.interlaced = false;
	//options.includeProfile = false;
	//activeDocument.exportDocument(file, ExportType.SAVEFORWEB, options);

	// SaveAs sometimes writes a huge amount of XML in the PNG. Ignore it or use Oxipng to make smaller PNGs.
	var options = new PNGSaveOptions();
	options.compression = 6;
	activeDocument.saveAs(file, options, true, Extension.LOWERCASE);
}

function getLayerCount () {
	var ref = new ActionReference();
	ref.putProperty(cID("Prpr"), sID("numberOfLayers"));
	ref.putEnumerated(cID("Dcmn"), cID("Ordn"), cID("Trgt"));
	return executeActionGet(ref).getInteger(sID("numberOfLayers"));
}

function getLayerID (index) {
	var ref = new ActionReference();
	ref.putProperty(cID("Prpr"), sID("layerID"));
	ref.putIndex(cID("Lyr "), index);
	return executeActionGet(ref).getInteger(sID("layerID"));
}

function hasBackgroundLayer () {
   try {
      var ref = new ActionReference(); 
      ref.putProperty(cID("Prpr"), sID("hasBackgroundLayer")); 
      ref.putEnumerated(cID("Dcmn"), cID("Ordn"), cID("Trgt"));
      return executeActionGet(ref).getBoolean(sID("hasBackgroundLayer"));
   } catch (e) { // CS2.
      try {
         return activeDocument.backgroundLayer;
      } catch (ignored) {
      }
      return false;
   }
}

function getSelectedLayers () {
	var layers = [];
	var ref = new ActionReference();
	ref.putEnumerated(cID("Dcmn"), cID("Ordn"), cID("Trgt"));
	var desc = executeActionGet(ref);
	if (desc.hasKey(sID("targetLayers"))) {
		desc = desc.getList(sID("targetLayers"));
		for (var i = 0, n = desc.count; i < n; i++)
			layers.push(getLayerID(desc.getReference(i).getIndex() + 1));
	}
	return layers;
}

function typeToMethod (type) {
	if (type == "DescValueType.ENUMERATEDTYPE") return "EnumerationValue";
	if (type == "DescValueType.OBJECTTYPE") return "ObjectValue";
	if (type == "DescValueType.UNITDOUBLE") return "Double";
	if (type == "DescValueType.INTEGERTYPE") return "Integer";
	if (type == "DescValueType.STRINGTYPE") return "String";
	if (type == "DescValueType.BOOLEANTYPE") return "Boolean";
	if (type == "DescValueType.LISTTYPE") return "List";
	if (type == "DescValueType.REFERENCETYPE") return "Reference";
	throw new Error("Unknown type: " + type);
}

// Example:
//	var ref = new ActionReference();
//	ref.putIdentifier(cID("Lyr "), layer.id);
//	alert(properties(executeActionGet(ref)));
function properties (object, indent) {
	if (!indent) indent = 0;
	var text = "";
	for (var i = 0, n = object.count; i < n; i++) {
		var key = object.getKey(i);
		var type = typeToMethod(object.getType(key));
		var value = object["get" + type](key);
		if (type == "EnumerationValue") value = tID(value);
		else if (type == "ObjectValue") value = "{\n" + properties(value, indent + 1) + "}";
		else if (type == "List") {
			var items = "";
			for (var ii = 0, nn = value.count; ii < nn; ii++) {
				var itemType = typeToMethod(value.getType(ii));
				items += properties(value["get" + itemType](ii), indent + 1);
			}
			if (items) items = "\n" + items;
			value = "[" + items + "]";
		}
		for (var ii = 0; ii < indent; ii++)
			text += "  ";
		text += tID(key) + ": " + value + " (" + type + ")\n";
	}
	return text;
}

// Layer class.

function Layer (id, parent, selected) {
	this.id = id;
	this.parent = parent;
	this.selected = selected;

	this.name = this.get("name", "String");

	var type = tID(this.get("layerSection", "EnumerationValue"));
	this.isGroupEnd = type == "layerSectionEnd";
	if (this.isGroupEnd) return;
	this.isGroup = type == "layerSectionStart";
	this.isLayer = type == "layerSectionContent";

	this.visible = this.get("visible", "Boolean");
	this.background = this.get("background", "Boolean");
	this.locked = this.get("layerLocking", "ObjectValue").getBoolean(sID("protectAll"));
	this.blendMode = tID(this.get("mode", "EnumerationValue"));
	this.clipping = this.get("group", "Boolean");

	this.mask = this.get("hasUserMask", "Boolean", function () {
		return false; // CS2.
	});

	this.adjustment = this.get("layerKind", "Integer", function () {
		return 0;
	}) == 2/*kAdjustmentSheet*/;

	this.boundsDirty = true;
	if (this.isGroup) this.layers = [];
}

Layer.prototype.get = function (name, type, error) {
	var property = sID(name);
	var ref = new ActionReference();
	ref.putProperty(cID("Prpr"), property);
	ref.putIdentifier(cID("Lyr "), this.id);
	try {
		return executeActionGet(ref)["get" + type](property);
	} catch (e) {
		if (error) return error();
		e.message = "Unable to get layer " + this + " property: " + name + "\n" + e.message;
		throw e;
	}
};

Layer.prototype.has = function (name) {
	var property = sID(name);
	var ref = new ActionReference();
	ref.putProperty(cID("Prpr"), property);
	ref.putIdentifier(cID("Lyr "), this.id);
	try {
		return executeActionGet(ref).hasKey(property);
	} catch (ignored) {}
	return false;
};

Layer.prototype.getIndex = function () {
	return this.get("itemIndex", "Integer");
};

Layer.prototype.isNormal = function () {
	var layer = this;
	return this.get("layerKind", "Integer", function () {
		return layer.has("smartObject") ? 5/*kSmartObjectSheet*/ : 1/*kPixelSheet*/;
	}) == 1/*kPixelSheet*/;
};

Layer.prototype.setClippingMask = function (clipping) {
	var ref = new ActionReference();
	ref.putIdentifier(cID("Lyr "), this.id);
	var desc = new ActionDescriptor();
	desc.putReference(cID("null"), ref);
	try {
		executeAction(cID(clipping ? "GrpL" : "Ungr"), desc, DialogModes.NO);
	} catch (ignored) {} // Fails if already in the desired state.
};

Layer.prototype.setVisible = function (visible) {
	if (this.visible == visible) return;
	this.visible = visible;
	var ref = new ActionReference();
	ref.putIdentifier(cID("Lyr "), this.id);
	var desc = new ActionDescriptor();
	desc.putReference(cID("null"), ref);
	executeAction(cID(visible ? "Shw " : "Hd  "), desc, DialogModes.NO);
};

Layer.prototype.hide = function () {
	this.setVisible(false);
};

Layer.prototype.show = function () {
	this.setVisible(true);
};

Layer.prototype.setLocked = function (locked) {
	if (this.locked == locked) return;
	this.locked = locked;
	var desc1 = new ActionDescriptor();
	var ref = new ActionReference();
	ref.putIdentifier(cID("Lyr "), this.id);
	desc1.putReference(cID("null"), ref);
	var desc2 = new ActionDescriptor();
	desc2.putBoolean(sID("protectNone"), true);
	desc1.putObject(sID("layerLocking"), sID("layerLocking"), desc2);
	executeAction(sID("applyLocking"), desc1, DialogModes.NO);
};

Layer.prototype.unlock = function () {
	this.setLocked(false);
	if (!this.layers) return;
	for (var i = this.layers.length - 1; i >= 0; i--)
		this.layers[i].unlock();
};

Layer.prototype.moveAbove = function (otherLayer) {
	var ref1 = new ActionReference();
	ref1.putIdentifier(cID("Lyr "), this.id);
	var ref2 = new ActionReference();
	ref2.putIndex(cID("Lyr "), otherLayer.getIndex());
	var desc = new ActionDescriptor();
	desc.putReference(cID("null"), ref1);
	desc.putReference(cID("T   "), ref2);
	desc.putBoolean(cID("Adjs"), false);
	executeAction(cID("move"), desc, DialogModes.NO);
};

Layer.prototype.deleteLayer = function () {
	this.unlock();
	var ref = new ActionReference();
	ref.putIdentifier(cID("Lyr "), this.id);
	var desc = new ActionDescriptor();
	desc.putReference(cID("null"), ref);
	executeAction(cID("Dlt "), desc, DialogModes.NO);
};

Layer.prototype.rasterize = function () {
	var ref = new ActionReference();
	ref.putIdentifier(cID("Lyr "), this.id);
	var desc = new ActionDescriptor();
	desc.putReference(cID("null"), ref);
	executeAction(sID("rasterizeLayer"), desc, DialogModes.NO);
};

Layer.prototype.rasterizeStyles = function () {
	if (!this.has("layerEffects")) return;
	this.select();
	try {
		merge(); // Merges any clipping masks.
	} catch (ignored) {}
	newLayerBelow(this.name);
	this.select(true);
	merge();
	this.boundsDirty = true;

	// Rasterizing styles may not give the desired results in all cases, merge does.
	//var ref = new ActionReference();
	//ref.putProperty(cID("Prpr"), sID("layerEffects"));
	//ref.putIdentifier(cID("Lyr "), this.id);
	//if (executeActionGet(ref).hasKey(sID("layerEffects"))) {
	//	var desc = new ActionDescriptor();
	//	desc.putReference(cID("null"), ref);
	//	desc.putEnumerated(cID("What"), sID("rasterizeItem"), sID("layerStyle"));
	//	executeAction(sID("rasterizeLayer"), desc, DialogModes.NO);
	//}
};

Layer.prototype.updateBounds = function () {
	if (!this.boundsDirty) return;
	this.boundsDirty = false;

	var bounds;
	if (this.mask) {
		this.select();
		bounds = channelBounds("mask");
		if (bounds) {
			this.left = bounds[0].as("px");
			this.top = bounds[1].as("px");
			this.right = bounds[2].as("px");
			this.bottom = bounds[3].as("px");
		}
	}
	if (!bounds) {
		try {
			bounds = this.get("boundsNoEffects", "ObjectValue");
		} catch (e) { // CS2.
			bounds = this.get("bounds", "ObjectValue"); // Not tightly fitting if there are layer styles.
		}
		this.left = bounds.getDouble(sID("left"));
		this.top = bounds.getDouble(sID("top"));
		this.right = bounds.getDouble(sID("right"));
		this.bottom = bounds.getDouble(sID("bottom"));
	}
	this.width = this.right - this.left;
	this.height = this.bottom - this.top;
};

Layer.prototype.select = function (add) {
	var ref = new ActionReference();
	ref.putIdentifier(cID("Lyr "), this.id);
	var desc = new ActionDescriptor();
	desc.putReference(cID("null"), ref);
	if (add) desc.putEnumerated(sID("selectionModifier"), sID("selectionModifierType"), sID("addToSelection"));
	desc.putBoolean(cID("MkVs"), false);
	executeAction(cID("slct"), desc, DialogModes.NO);
};

Layer.prototype.applyNamePatterns = function (name) {
	var layer = this.findTagLayer("name:");
	if (!layer) return name;
	var namePattern = layer.getTagValue("name:");
	if (namePattern) {
		var asterisk = namePattern.indexOf("*");
		if (asterisk == -1) {
			error("The pattern for the [name:pattern] tag must contain an asterisk (*):\n\n" + layer.name);
			return null;
		}
		name = namePattern.substring(0, asterisk) + name + namePattern.substring(asterisk + 1);
	}
	return layer.parent ? layer.parent.applyNamePatterns(name) : name;
};

Layer.prototype.findTagLayer = function (tag) {
	var groupTag = isValidGroupTag(tag), layerTag = isValidLayerTag(tag);
	if (endsWith(tag, ":")) tag = tag.slice(0, -1);
	var re = new RegExp("\\[" + tag + "(:[^\\]]+)?\\]", "i");
	var layer = this;
	while (layer) {
		if (((layer.isGroup && groupTag) || (layer.isLayer && layerTag)) && re.exec(layer.name)) return layer;
		layer = layer.parent;
	}
	return null;
};

Layer.prototype.findTagValue = function (tag, noValue) {
	var layer = this.findTagLayer(tag);
	if (!layer) return null;
	return layer.getTagValue(tag, noValue);
};

Layer.prototype.getTagValue = function (tag, noValue) {
	if (endsWith(tag, ":")) tag = tag.slice(0, -1);
	var matches = new RegExp("\\[" + tag + ":([^\\]]+)\\]", "i").exec(this.name);
	if (matches && matches.length) return trim(matches[1]);
	if (noValue) return noValue;
	return stripTags(this.name);
};

Layer.prototype.getParentBone = function (bones) {
	var parentName = this.parent ? this.parent.findTagValue("bone") : null;
	if (!parentName) parentName = "root";
	var parent = get(bones, parentName);
	if (!parent) { // Parent bone group with no attachment layers.
		var parentParent = this.parent.getParentBone(bones);
		set(bones, parentName, parent = { name: parentName, x: 0, y: 0, parent: parentParent, children: [], layer: this.parent });
		parentParent.children.push(parent);
	}
	return parent;
};

var foldersRE = new RegExp("\\[(folder|skin)(:[^\\]]+)?\\]", "i");
Layer.prototype.folders = function (path) {
	var layer = this;
	while (layer) {
		var matches = foldersRE.exec(layer.name);
		if (matches) {
			var folder = layer.findTagValue(matches[1]);
			if (matches[1] == "skin" && folder == "default") return layer.parent.folders(path);
			path = folder + "/" + path;
			if (startsWith(folder, "/")) return path;
			return layer.parent ? layer.parent.folders(path) : path;
		}
		layer = layer.parent;
	}
	return path;
};

Layer.prototype.path = function (path) {
	var layer = this;
	var path = layer.name;
	while (true) {
		layer = layer.parent;
		if (!layer) return path;
		path = layer.name + "/" + path;
	}
};

Layer.prototype.toString = function () {
	return this.name ? this.path() : this.id;
};

// JavaScript utility:

function joinKeys (object, glue) {
	if (!glue) glue = ", ";
	var value = "";
	for (var key in object) {
		if (object.hasOwnProperty(key)) {
			if (value) value += glue;
			value += key;
		}
	}
	return value;
}

function joinValues (object, glue) {
	if (!glue) glue = ", ";
	var value = "";
	for (var key in object) {
		if (object.hasOwnProperty(key)) {
			if (value) value += glue;
			value += object[key];
		}
	}
	return value;
}

function indexOf (array, value) {
	for (var i = 0, n = array.length; i < n; i++)
		if (array[i] == value) return i;
	return -1;
}

function trim (value) {
	return value.replace(/^\s+|\s+$/g, "");
}

function startsWith (str, prefix) {
	return str.indexOf(prefix) === 0;
}

function endsWith (str, suffix) {
	return !(str.indexOf(suffix, str.length - suffix.length) === -1);
}

function quote (value) {
	return '"' + value.replace(/"/g, '\\"') + '"';
}

function forwardSlashes (path) {
	return path.replace(/\\/g, "/");
}

showSettingsDialog();
