pipeline {
    agent any

    environment {
                NODE_VERSION = '18'
    }

    stages {
        stage('clean workspace & CSM') {
            steps {
                cleanWS()
                checkout scm
            }
        }

        stage('installing dependencies') {
            steps{
                sh 'npm install'
            }
        }

        stage('Testing') {
            sh 'npm test'
        }

    post {
    always {
        cleanWs()
    }
    success {
        echo 'Pipeline completed successfully!'
    }
    failure {
        echo 'Pipeline failed!'
    }
    }
}
}