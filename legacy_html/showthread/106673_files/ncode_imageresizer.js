




/*
     FILE ARCHIVED ON 4:45:03 Sep 20, 2012 AND RETRIEVED FROM THE
     INTERNET ARCHIVE ON 8:32:40 Apr 5, 2015.
     JAVASCRIPT APPENDED BY WAYBACK MACHINE, COPYRIGHT INTERNET ARCHIVE.

     ALL OTHER CONTENT MAY ALSO BE PROTECTED BY COPYRIGHT (17 U.S.C.
     SECTION 108(a)(3)).
*/
// nCode Image Resizer for vBulletin 3.6.0
// /web/20120920044503/http://www.ncode.nl/vbulletinplugins/
// Version: 1.0.1
//
// (c) 2007 nCode


NcodeImageResizer.IMAGE_ID_BASE = 'ncode_imageresizer_container_';
NcodeImageResizer.WARNING_ID_BASE = 'ncode_imageresizer_warning_';
NcodeImageResizer.scheduledResizes = [];

function NcodeImageResizer(id, img) {
	this.id = id;
	this.img = img;
	this.originalWidth = 0;
	this.originalHeight = 0;
	this.warning = null;
	this.warningTextNode = null;
	this.originalWidth = img.originalWidth;
	this.originalHeight = img.originalHeight;
	
	img.id = NcodeImageResizer.IMAGE_ID_BASE+id;
}

NcodeImageResizer.executeOnload = function() {
	var rss = NcodeImageResizer.scheduledResizes;
	for(var i = 0; i  < rss.length; i++) {
		NcodeImageResizer.createOn(rss[i], true);
	}
}

NcodeImageResizer.schedule = function(img) {
	if(NcodeImageResizer.scheduledResizes.length == 0) {
		if(window.addEventListener) {
			window.addEventListener('load', NcodeImageResizer.executeOnload, false);
		} else if(window.attachEvent) {
			window.attachEvent('onload', NcodeImageResizer.executeOnload);
		}
	}
	NcodeImageResizer.scheduledResizes.push(img);
}

NcodeImageResizer.getNextId = function() {
	var id = 1;
	while(document.getElementById(NcodeImageResizer.IMAGE_ID_BASE+id) != null) {
		id++;
	}
	return id;
}

NcodeImageResizer.createOnId = function(id) {
	return NcodeImageResizer.createOn(document.getElementById(id));
}

NcodeImageResizer.createOn = function(img, isSchedule) {
	if(typeof isSchedule == 'undefined') isSchedule = false;
	
	if(!img || !img.tagName || img.tagName.toLowerCase() != 'img') {
		alert(img+' is not an image ('+img.tagName.toLowerCase()+')');
	}
	
	if(img.width == 0 || img.height == 0) {
		if(!isSchedule)
			NcodeImageResizer.schedule(img);
		return;
	}
	
	if(!img.originalWidth) img.originalWidth = img.width;
	if(!img.originalHeight) img.originalHeight = img.height;
	
	if((NcodeImageResizer.MAXWIDTH > 0 && img.originalWidth > NcodeImageResizer.MAXWIDTH) || (NcodeImageResizer.MAXHEIGHT > 0 && img.originalHeight > NcodeImageResizer.MAXHEIGHT)) {
		var isRecovery = false; // if this is a recovery from QuickEdit, which only restores the HTML, not the OO structure
		var newid, resizer;
		if(img.id && img.id.indexOf(NcodeImageResizer.IMAGE_ID_BASE) == 0) {
			newid = img.id.substr(NcodeImageResizer.IMAGE_ID_BASE.length);
			if(document.getElementById(NcodeImageResizer.WARNING_ID_BASE+newid) != null) {
				resizer = new NcodeImageResizer(newid, img);
				isRecovery = true;
				resizer.restoreImage();
			}
		} else {
			newid = NcodeImageResizer.getNextId();
			resizer = new NcodeImageResizer(newid, img);
		}
		
		if(isRecovery) {
			resizer.reclaimWarning(newid);
		} else {
			resizer.createWarning();
		}
		resizer.scale();
	}
}

NcodeImageResizer.prototype.restoreImage = function() {
	newimg = document.createElement('IMG');
	newimg.src = this.img.src;
	this.img.width = newimg.width;
	this.img.height = newimg.height;
}

NcodeImageResizer.prototype.reclaimWarning = function(id) {
	this.warning = document.getElementById(NcodeImageResizer.WARNING_ID_BASE+id);
	this.warningTextNode = this.warning.firstChild.firstChild.childNodes[1].firstChild;
	this.warning.resize = this;
	
	this.scale();
}

NcodeImageResizer.prototype.createWarning = function() {
	var mtable = document.createElement('TABLE');
	var mtbody = document.createElement('TBODY');
	var mtr = document.createElement('TR');
	var mtd1 = document.createElement('TD');
	var mtd2 = document.createElement('TD');
	var mimg = document.createElement('IMG');
	var mtext = document.createTextNode('');
	
	mimg.src = NcodeImageResizer.BBURL+'/images/statusicon/wol_error.gif';
	mimg.width = 16;
	mimg.height = 16;
	mimg.alt = '';
	mimg.border = 0;
	
	mtd1.width = 20;
	mtd1.className = 'td1';
	
	mtd2.unselectable = 'on';
	mtd2.className = 'td2';
	
	mtable.className = 'ncode_imageresizer_warning';
	mtable.textNode = mtext;
	mtable.resize = this;
	mtable.id = NcodeImageResizer.WARNING_ID_BASE+this.id;
	
	mtd1.appendChild(mimg);
	mtd2.appendChild(mtext);
	
	mtr.appendChild(mtd1);
	mtr.appendChild(mtd2);
	
	mtbody.appendChild(mtr);
	
	mtable.appendChild(mtbody);
	
	this.img.parentNode.insertBefore(mtable, this.img);
	
	this.warning = mtable;
	this.warningTextNode = mtext;
}

NcodeImageResizer.prototype.setText = function(text) {
	var newnode = document.createTextNode(text);
	this.warningTextNode.parentNode.replaceChild(newnode, this.warningTextNode);
	this.warningTextNode = newnode;
}

NcodeImageResizer.prototype.scale = function() {
	this.img.height = this.originalHeight;
	this.img.width = this.originalWidth;
	
	if(NcodeImageResizer.MAXWIDTH > 0 && this.img.width > NcodeImageResizer.MAXWIDTH) {
		this.img.height = (NcodeImageResizer.MAXWIDTH / this.img.width) * this.img.height;
		this.img.width = NcodeImageResizer.MAXWIDTH;
	}
	
	if(NcodeImageResizer.MAXHEIGHT > 0 && this.img.height > NcodeImageResizer.MAXHEIGHT) {
		this.img.width = (NcodeImageResizer.MAXHEIGHT / this.img.height) * this.img.width;
		this.img.height = NcodeImageResizer.MAXHEIGHT;
	}
	
	this.warning.width = this.img.width;
	this.warning.onclick = function() { return this.resize.unScale(); }
	
	if(this.img.width < 450) {
		this.setText(vbphrase['ncode_imageresizer_warning_small']);
	} else if(this.img.fileSize && this.img.fileSize > 0) {
		this.setText(vbphrase['ncode_imageresizer_warning_filesize'].replace('%1$s', this.originalWidth).replace('%2$s', this.originalHeight).replace('%3$s', Math.round(this.img.fileSize/1024)));
	} else {
		this.setText(vbphrase['ncode_imageresizer_warning_no_filesize'].replace('%1$s', this.originalWidth).replace('%2$s', this.originalHeight));
	}
	
	return false;
}

NcodeImageResizer.prototype.unScale = function() {
	switch(NcodeImageResizer.MODE) {
		case 'samewindow':
			window.open(this.img.src, '_self');
			break;
		case 'newwindow':
			window.open(this.img.src, '_blank');
			break;
		case 'enlarge':
		default:
			this.img.width = this.originalWidth;
			this.img.height = this.originalHeight;
			this.img.className = 'ncode_imageresizer_original';
			if(this.warning != null) {
				this.setText(vbphrase['ncode_imageresizer_warning_fullsize']);
				this.warning.width = this.img.width;
				this.warning.onclick = function() { return this.resize.scale() };
			}
			break;
	}
	
	return false;
}