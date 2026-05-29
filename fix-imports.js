import fs from "fs";
import path from "path";

// Fonction pour vérifier si l'import est local (relatif ou parent)
const isLocalImport = (importPath) => {
    return importPath.startsWith('./') || importPath.startsWith('../');
};

// Fonction pour vérifier si l'import est l'index
const isIndexFile = (importPath) => {
    return importPath.endsWith('/index') || importPath.endsWith('/index.js') || importPath.endsWith('/index.mjs');
}

// Fonction pour ajouter ".js" si l'import est local et ne possède pas déjà l'extension
const fixImport = (importLine) => {
    return importLine.replace(/(from\s+['"])(.*?)(['"])/g, (match, before, importPath, after) => {
        if (isLocalImport(importPath)) {
            if (isIndexFile(importPath)) {
                if (!importPath.endsWith('.mjs')) return `${before}${importPath.split(".")[0]}.mjs${after}`;
            } else if (!importPath.endsWith('.js')) {
                return `${before}${importPath}.js${after}`;
            }
        }
        return match;
    });
};

// Lire tous les fichiers TypeScript dans un dossier donné
const processFiles = (directory) => {
    fs.readdirSync(directory).forEach((file) => {
        const fullPath = path.join(directory, file);

        // Si c'est un dossier, on le traite récursivement
        if (fs.lstatSync(fullPath).isDirectory()) {
            // Si c'est un dossier à ignorer on le saute
            if (ignoredFolders.includes(file)) return;
            processFiles(fullPath);
        }
        // Si c'est un fichier TypeScript ou JavaScript, on le traite
        else if (file.endsWith('.ts') || file.endsWith('.js') || file.endsWith('.mts') || file.endsWith('.mjs')) {
            const content = fs.readFileSync(fullPath, 'utf-8');
            const fixedContent = content.split('\n').map(fixImport).join('\n');

            // Écrire le contenu corrigé dans le fichier
            fs.writeFileSync(fullPath, fixedContent, 'utf-8');

            if (content !== fixedContent) {
                console.log(`✔ Imports corrigés dans : ${fullPath}`);
            }
        }
    });
};

// Dossier de base à traiter
const baseDirectory = path.resolve(process.argv[2] || '.');

// Dossiers à ignorer
const ignoredFolders = ['node_modules', 'dist'];

// Lancer le traitement des fichiers
processFiles(baseDirectory);