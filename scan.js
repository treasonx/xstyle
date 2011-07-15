// summary:
//		This script scans for stylesheets and flattens imports in IE (to fix the deep import bug),
//		and loads any extension modules that are referenced by imports 
if(typeof define == "undefined"){
	define = function(deps, factory){
		factory();
	};
}
define([], function(){
	function search(tag){
		var elements = document.getElementsByTagName(tag);
		for(var i = 0; i < elements.length; i++){
			process(elements[i]);
		}
	}
	var insertedSheets = {},
		features = {
			"dom-deep-import": !document.createStyleSheet // essentially test to see if it is IE, inaccurate marker, maybe should use dom-addeventlistener? 
		};
	function has (feature) {
		return features[feature];
	}
	var modules = [];
	// load any plugin modules when done parsing
	function process(link, callback){
		var sheet = link.sheet || link.styleSheet;
		
		function processAfterFix(sheet){
			loadOnce(sheet);
			loadingCount = modules.length + 1;
			require(modules, function(){
				for(var i = 0; i < arguments.length; i++){
					var module = arguments[i];
					module.process(sheet, finishedModule);	
				}
			});
			function finishedModule(){
				if(!--loadingCount){
					callback && callback(sheet);
				}
			}
			finishedModule();
		}
		if(!has("dom-deep-import")){
			// in IE, so we flatten the imports due to IE's lack of support for deeply nested @imports
			// and fix the computation of URLs (IE calculates them wrong)
			var computeImportUrls = function(sheet, baseUrl){
				var computedUrls = []
				// IE miscalculates .href properties, so we calculate them by parsing
				sheet.cssText.replace(/@import url\( ([^ ]+) \)/g, function(t, url){
						// we have to actually parse the cssText because IE's href property is totally wrong
						computedUrls.push(absoluteUrl(baseUrl, url));
					});
				return computedUrls;
			},
			flattenImports = function(){
				// IE doesn't support deeply nested @imports, so we flatten them.
				//	IE needs imports rearranged and then to go through on a later turn.
				// This function is a big pile of IE fixes
				var flatteningOccurred, sheet = link.styleSheet;
				if(sheet.processed){
					return;
				}
				var sheetHref = sheet.correctHref = absoluteUrl(location.toString(), sheet.href);
				if(!sheet.computedUrls){
					// we have to do in a pre-loop or else IE's messes up on it's ownerRule's order
					sheet.computedUrls = computeImportUrls(sheet, sheetHref);
				}
				for(var i = 0; i < sheet.imports.length; i++){
					var importedSheet = sheet.imports[i];
					if(!importedSheet.cssText && !importedSheet.imports.length){ // empty means it is not loaded yet, try again later
						setTimeout(flattenImports, 50);
						return;
					}
				//	importedSheet.loaded = true;
					var correctHref = importedSheet.correctHref = sheet.computedUrls[i];
					
					var childHrefs = computeImportUrls(importedSheet, correctHref);
					// Deep in an IE stylesheet
					for(var j = 0; j < importedSheet.imports.length; j++){
						// TODO: Think we can just stay in place and remove
						var subImport = importedSheet.imports[j];
						if(!subImport.correctHref){
							flatteningOccurred = true;
							link.onload = flattenImports;
							var childHref = childHrefs[j] || importedSheet.href;
							sheet.computedUrls.splice(i, 0, childHref);
							try{
								sheet.addImport(childHref, i++);
							}catch(e){
								// this will fail if there are too many imports
							}
							subImport.correctHref = childHref; 
						}
					}
				}
				if(flatteningOccurred){
					setTimeout(flattenImports, 50);
				}else{
					sheet.processed = true;
					processAfterFix(sheet);
				}
			}
			return flattenImports();
		}
		processAfterFix(sheet);
		function loadOnce(sheet, baseUrl){
			// This function is responsible for implementing the @import once
			// semantics, such extra @imports that resolve to the same
			// CSS file are eliminated, and only the first one is kept
			
			var href = absoluteUrl(baseUrl, sheet.correctHref || sheet.href);
			// do normalization 
			if(!sheet.addRule){
				// only FF doesn't have this
				sheet.addRule = function(selector, style, index){
					return this.insertRule(selector + "{" + style + "}", index >= 0 ? index : this.cssRules.length);
				}
			}
			if(!sheet.deleteRule){
				sheet.deleteRule = sheet.removeRule;
			}
			var existingSheet = href && insertedSheets[href]; 
			if(existingSheet){
				var sheetToDelete;
				if(existingSheet != sheet){
					var parentStyleSheet = sheet.parentStyleSheet;
					var existingElement = existingSheet.ownerElement;
					if(existingElement.compareDocumentPosition ? 
							existingElement.compareDocumentPosition(link) != 2 :
							existingElement.sourceIndex <= link.sourceIndex){
						// this new sheet is after (or current), so we kill this one
						sheetToDelete = sheet;
					}else{
						// the other sheet is after, so delete it
						sheetToDelete = existingSheet;
						existingSheet = insertedSheets[href] = sheet;
					}
					var owner = sheetToDelete.ownerNode || !parentStyleSheet && sheetToDelete.owningElement;
					if(owner){
						// it is top level <link>, remove the node (disabling doesn't work properly in IE, but node removal works everywhere)
						owner.parentNode.removeChild(owner); 
					}else{
						// disabling is the only way to remove an imported stylesheet in firefox; it doesn't work in IE and WebKit
						sheetToDelete.disabled = true; // this works in Opera
						if("cssText" in sheetToDelete){
							sheetToDelete.cssText =""; // this works in IE
						}else{
							// removing the rule is only way to remove an imported stylesheet in WebKit
							owner = sheetToDelete.ownerRule;
							if(owner){
								try{
									var parentStyleSheet = owner.parentStyleSheet;
									var parentRules = parentStyleSheet.cssRules;
									for(var i = 0; i < parentRules.length; i++){
										// find the index of the owner rule that we want to delete
										if(parentRules[i] == owner){
											parentStyleSheet.deleteRule(i);
											break;
										}
									}
									return true;
								}catch(e){
									// opera fails on deleteRule for imports, but the disabled works, so we can continue
									console.log(e);
								}
							}
						}
					}
				}
			}
			if(sheetToDelete != sheet){
				if(href){
					// record the stylesheet in our hash
					insertedSheets[href] = sheet;
					sheet.ownerElement = link;
				}
				// now recurse into @import's to check to make sure each of those is only loaded once 
				var importRules = sheet.imports || sheet.rules || sheet.cssRules;
				
				for(var i = 0; i < importRules.length; i++){										
					var rule = importRules[i];
					if(rule.href){
						// it's an import (for non-IE browsers we are looking at all rules, and need to exclude non-import rules
						var parentStyleSheet = sheet; 
						sheet = rule.styleSheet || rule;
						if(rule.href.substring(0,7) == "module:"){
							// handle @import "module:<module-id>"; as an extension module that
							//	can perform extra processing. cssx.js can be loaded as 
							//	dependency of a stylesheet this way
							modules.push(absoluteUrl(href, rule.href.substring(7)));
						}else if(loadOnce(sheet, href)){
							i--; // deleted, so go back in index
						}
					}
				}
			}
		}
	}
	function absoluteUrl(base, url) {
		if(!url || url.indexOf(":") > 0 || url.charAt(0) == '/'){
			return url;
		}
		// in IE we do this trick to get the absolute URL
		var lastUrl;
		url = ((base || location.toString()).replace(/[^\/]*$/,'') + url).replace(/\/\.\//g,'/');
		while(lastUrl != url){
			lastUrl = url;
			url = url.replace(/\/[^\/]+\/\.\.\//g, '/');
		}
		return url;
	}
	search('link');
	search('style');
	return {
		process: process
	};
	
});